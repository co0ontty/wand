#!/usr/bin/env bash
#
# start.sh — 用 npm link 把仓库符号链接到全局，并通过 system-wide systemd 管理。
#
# 流程（默认）：
#   1) npm run build                                   # 构建 dist/
#   2) npm link                                        # 全局 wand → 本仓库（符号链接，无需打包）
#   3) wand service:install / service:restart          # 走 src/tui/commands.ts，写 /etc/systemd/system/wand.service
#   4) 打印面板（脚本退出后 service 继续在 systemd 下跑）
#
# 用 system-wide systemd（/etc/systemd/system/wand.service）的原因：
#   - 开机自启，不依赖 login session，不需要 enable-linger
#   - service wand start / systemctl status wand 等老命令都好使
#   - 多用户场景下也能复用同一个实例
#
# 代价：装/卸需要 root。脚本会自动 sudo 包裹要 root 的命令，已经是 root 就直接来。
# 如果你**确实**想要 user-level（不需要 root，但登出会被回收），传 --user。
#
# 用法：
#   ./start.sh                # 默认：build → pack → install → service:install/restart（system）
#   ./start.sh --user         # 改装 user-level service（~/.config/systemd/user/wand.service）
#   ./start.sh --attach       # 不动 service，直接 attach 到运行中的实例的 TUI
#   ./start.sh --no-build     # 跳过构建（dist/ 你已确认是新的）
#   ./start.sh --skip-install # 跳过 pack + install，只 restart
#   ./start.sh --restart      # 只 restart 现有服务（不重新打包）
#   ./start.sh --status       # 打印面板（不动 service）
#   ./start.sh --logs         # journalctl -u wand -f
#   ./start.sh --stop         # 停 service（不卸载）
#   ./start.sh --uninstall    # 完整卸载：wand service:uninstall + npm uninstall -g
#   ./start.sh --port 8443    # 改服务端口（写进 ~/.wand/config.json 再 restart）
#
# 安全保证：
#   - service 跑在 systemd 下，本脚本退出/Ctrl-C 都不会停 service。
#   - install 阶段 Ctrl-C 中断：当前 service 仍用旧二进制继续跑。
#   - 重启阶段 Ctrl-C 中断：service 可能进入未定义状态，重跑 ./start.sh --restart 修复。
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ── 常量 ─────────────────────────────────────────────────────────────
SERVICE_NAME="wand"
CONFIG_PATH="${WAND_CONFIG:-$HOME/.wand/config.json}"

# ── 颜色 ─────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_DIM="\033[2m"; C_RED="\033[31m"; C_GREEN="\033[32m"
  C_YELLOW="\033[33m"; C_CYAN="\033[36m"; C_MAGENTA="\033[35m"
  C_BOLD="\033[1m"; C_RESET="\033[0m"
else
  C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_MAGENTA=""; C_BOLD=""; C_RESET=""
fi
msg()  { echo -e "${C_CYAN}→${C_RESET} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!${C_RESET} $*"; }
die()  { echo -e "${C_RED}✗${C_RESET} $*" >&2; exit 1; }

# ── 终端宽度 ─────────────────────────────────────────────────────────
TERM_COLS="$(tput cols 2>/dev/null || echo 78)"
[[ "$TERM_COLS" -lt 60 ]] && TERM_COLS=60
[[ "$TERM_COLS" -gt 100 ]] && TERM_COLS=100
rep() { printf '%.0s─' $(seq 1 "$1"); }
section() {
  local title="$1"
  local title_len=${#title}
  local left=3
  local right=$((TERM_COLS - left - title_len - 2))
  [[ $right -lt 3 ]] && right=3
  echo -e "${C_DIM}$(rep $left) ${C_RESET}${C_BOLD}${title}${C_RESET}${C_DIM} $(rep $right)${C_RESET}"
}
row() {
  local label="$1" value="$2"
  printf "  ${C_DIM}%-11s${C_RESET}  %b\n" "$label" "$value"
}

# ── 参数 ─────────────────────────────────────────────────────────────
ACTION="install-and-restart"   # 默认动作
DO_BUILD=1
DO_INSTALL=1
PORT_OVERRIDE=""
SCOPE="system"   # 默认 system；--user 切到 user

print_help() {
  awk 'NR==1 && /^#!/ {next} /^[^#[:space:]]/ || NR>60 {exit} {print}' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --attach)       ACTION="attach"; shift ;;
    --no-build)     DO_BUILD=0; shift ;;
    --skip-install) DO_INSTALL=0; shift ;;
    --status)       ACTION="status"; shift ;;
    --logs)         ACTION="logs"; shift ;;
    --stop)         ACTION="stop"; shift ;;
    --restart)      ACTION="restart-only"; shift ;;
    --uninstall)    ACTION="uninstall"; shift ;;
    --port)         PORT_OVERRIDE="$2"; shift 2 ;;
    --user)         SCOPE="user"; shift ;;
    --system)       SCOPE="system"; shift ;;
    -h|--help)      print_help; exit 0 ;;
    *) die "未知参数: $1（试试 --help）" ;;
  esac
done

# ── 系统前置检查 ─────────────────────────────────────────────────────
command -v systemctl >/dev/null 2>&1 || die "未找到 systemctl，本机不是 systemd 系统。"

# UNIT 路径跟 scope 走
if [[ "$SCOPE" == "user" ]]; then
  UNIT_FILE="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
  SYSTEMCTL=(systemctl --user)
  JOURNALCTL=(journalctl --user -u "$SERVICE_NAME")
  SCOPE_FLAG="--user"
else
  UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
  SYSTEMCTL=(systemctl)
  JOURNALCTL=(journalctl -u "$SERVICE_NAME")
  SCOPE_FLAG="--system"
fi

# sudo 自动决策：system scope 且非 root → 需要 sudo
SUDO=""
if [[ "$SCOPE" == "system" ]] && [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    warn "当前不是 root，会用 sudo 跑需要权限的命令"
  else
    die "system scope 需要 root 但找不到 sudo。要么用 sudo 重跑，要么 ./start.sh --user 走 user 级。"
  fi
fi

# 全局 wand 安装后会出现的路径；动态查
detect_wand_bin() { command -v wand 2>/dev/null || true; }
NODE_BIN="$(command -v node 2>/dev/null || true)"
[[ -n "$NODE_BIN" ]] || die "未找到 node。"

# user systemd / system systemd 是否安装了 wand.service
service_installed() { [[ -f "$UNIT_FILE" ]]; }

# ── 清残：把所有可能阻塞新实例启动的旧进程 / socket 收掉 ─────────────
cleanup_stale_wand() {
  local target_port="${PORT_OVERRIDE:-}"
  if [[ -z "$target_port" ]] && [[ -f "$CONFIG_PATH" ]]; then
    target_port="$(node -e "
      try { process.stdout.write(String(require('$CONFIG_PATH').port ?? '')); }
      catch(e) { process.stdout.write(''); }
    " 2>/dev/null)"
  fi
  target_port="${target_port:-8443}"

  # ── A) 端口占用者 ──
  if command -v lsof >/dev/null 2>&1; then
    local port_pids
    port_pids="$(lsof -ti :"$target_port" 2>/dev/null || true)"
    if [[ -n "$port_pids" ]]; then
      warn "端口 $target_port 被占用，kill: $(echo $port_pids | tr '\n' ' ')"
      $SUDO kill $port_pids 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        sleep 1
        [[ -z "$(lsof -ti :"$target_port" 2>/dev/null)" ]] && break
      done
      if [[ -n "$(lsof -ti :"$target_port" 2>/dev/null)" ]]; then
        warn "$target_port 仍被占，SIGKILL"
        $SUDO kill -9 $(lsof -ti :"$target_port" 2>/dev/null) 2>/dev/null || true
        sleep 1
      fi
    fi
  fi

  # ── B) 残留 wand 进程 ──
  local pat='(^|/)wand[[:space:]]+web|/cli\.js[[:space:]]+web|tsx[^[:space:]]*[[:space:]]+src/cli\.ts[[:space:]]+web'
  local stale_pids
  stale_pids="$(pgrep -af "$pat" 2>/dev/null | awk '{print $1}' | grep -vx "$$" || true)"
  if [[ -n "$stale_pids" ]]; then
    warn "残留 wand 进程，kill: $(echo $stale_pids | tr '\n' ' ')"
    echo "$stale_pids" | xargs -r $SUDO kill 2>/dev/null || true
    sleep 1
    stale_pids="$(pgrep -af "$pat" 2>/dev/null | awk '{print $1}' | grep -vx "$$" || true)"
    [[ -n "$stale_pids" ]] && {
      warn "仍有残留，SIGKILL: $(echo $stale_pids | tr '\n' ' ')"
      echo "$stale_pids" | xargs -r $SUDO kill -9 2>/dev/null || true
    }
  fi

  # ── C) 崩溃残留的 unix socket 文件 ──
  [[ -S "$HOME/.wand/wand.sock" ]] && rm -f "$HOME/.wand/wand.sock"
}

# ── 装服务 / 重启服务 ────────────────────────────────────────────────
# 走 `wand service:install / restart` (= installService in src/tui/commands.ts:382)
# system scope 默认；如果脚本 --user 启动会传 --user 给 CLI
ensure_service_installed_and_running() {
  local wand_bin="${1:-}"
  [[ -z "$wand_bin" ]] && wand_bin="$(detect_wand_bin)"
  [[ -n "$wand_bin" ]] || die "找不到 wand 二进制，无法装/重启服务。"

  if service_installed; then
    msg "$SUDO $wand_bin service:restart $SCOPE_FLAG"
    if $SUDO "$wand_bin" service:restart "$SCOPE_FLAG"; then
      ok "服务已重启"
    else
      warn "service:restart 失败，尝试兜底：service:stop → cleanup → service:start"
      $SUDO "$wand_bin" service:stop "$SCOPE_FLAG" >/dev/null 2>&1 || true
      cleanup_stale_wand
      $SUDO "$wand_bin" service:start "$SCOPE_FLAG" || die "service:start 也失败了，看上面输出"
      ok "兜底 start 成功"
    fi
  else
    msg "未发现已注册的 $SCOPE systemd service，开始首次注册"
    msg "$SUDO $wand_bin service:install $SCOPE_FLAG"
    $SUDO "$wand_bin" service:install "$SCOPE_FLAG" || die "service:install 失败"
    ok "已注册并启动 wand $SCOPE service"
  fi
}

# ── attach：把当前终端接到运行中的 wand TUI ──────────────────────────
attach_to_running_service() {
  local wand_bin; wand_bin="$(detect_wand_bin)"
  [[ -z "$wand_bin" ]] && die "未找到全局 wand 命令；先跑 ./start.sh 安装一次。"

  local pid="?"
  if service_installed && "${SYSTEMCTL[@]}" is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    pid="$("${SYSTEMCTL[@]}" show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || echo '?')"
  fi
  echo
  echo -e "${C_BOLD}${C_YELLOW}⚠ 正在 attach 到运行中的 wand 实例${C_RESET}"
  echo -e "  ${C_DIM}scope: $SCOPE    service PID: ${pid}    socket: $HOME/.wand/wand.sock${C_RESET}"
  echo
  echo -e "  ${C_GREEN}Ctrl-C 只会退出本 TUI，不会停掉 service${C_RESET}"
  echo -e "  要操作 service，用："
  echo -e "    ${C_CYAN}./start.sh --restart${C_RESET}     重启（不重装）"
  echo -e "    ${C_CYAN}./start.sh${C_RESET}               重装最新代码 + 重启"
  echo -e "    ${C_CYAN}./start.sh --stop${C_RESET}        停 service"
  echo -e "    ${C_CYAN}./start.sh --logs${C_RESET}        看日志"
  echo
  msg "exec $wand_bin web -c $CONFIG_PATH"
  exec "$wand_bin" web -c "$CONFIG_PATH"
}

# ── 实时信息收集 ─────────────────────────────────────────────────────
collect_runtime() {
  SVC_ACTIVE="$("${SYSTEMCTL[@]}" is-active "$SERVICE_NAME" 2>/dev/null || echo 'unknown')"
  SVC_ENABLED="$("${SYSTEMCTL[@]}" is-enabled "$SERVICE_NAME" 2>/dev/null || echo 'unknown')"
  SVC_PID="$("${SYSTEMCTL[@]}" show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || echo '0')"
  SVC_MEM_RAW="$("${SYSTEMCTL[@]}" show -p MemoryCurrent --value "$SERVICE_NAME" 2>/dev/null || echo '0')"
  SVC_SINCE_RAW="$("${SYSTEMCTL[@]}" show -p ActiveEnterTimestamp --value "$SERVICE_NAME" 2>/dev/null || true)"

  if [[ "$SVC_MEM_RAW" =~ ^[0-9]+$ ]] && [[ "$SVC_MEM_RAW" -gt 0 ]]; then
    SVC_MEM="$(numfmt --to=iec --suffix=B "$SVC_MEM_RAW" 2>/dev/null || echo "${SVC_MEM_RAW}B")"
  else
    SVC_MEM="-"
  fi

  if [[ -n "$SVC_SINCE_RAW" ]] && [[ "$SVC_SINCE_RAW" != "n/a" ]]; then
    local since_epoch now_epoch delta
    since_epoch="$(date -d "$SVC_SINCE_RAW" +%s 2>/dev/null || echo 0)"
    now_epoch="$(date +%s)"
    delta=$(( now_epoch - since_epoch ))
    if [[ $delta -lt 60 ]]; then SVC_UPTIME="${delta}s"
    elif [[ $delta -lt 3600 ]]; then SVC_UPTIME="$((delta/60))m $((delta%60))s"
    elif [[ $delta -lt 86400 ]]; then SVC_UPTIME="$((delta/3600))h $(((delta%3600)/60))m"
    else SVC_UPTIME="$((delta/86400))d $(((delta%86400)/3600))h"
    fi
  else
    SVC_UPTIME="-"
  fi

  PORT="$(node -e "try{process.stdout.write(String(require('$CONFIG_PATH').port??''))}catch(e){process.stdout.write('?')}" 2>/dev/null)"
  HTTPS="$(node -e "try{process.stdout.write(String(require('$CONFIG_PATH').https===true))}catch(e){process.stdout.write('false')}" 2>/dev/null)"
  PROTO="http"; [[ "$HTTPS" == "true" ]] && PROTO="https"

  LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -vE '^(127\.|169\.254\.)' | head -1)"
  [[ -z "$LAN_IP" ]] && LAN_IP=""

  DB_FILE="$(dirname "$CONFIG_PATH")/wand.db"
  DB_PASSWORD=""
  DB_SIZE="-"
  SESSIONS_TOTAL="-"
  SESSIONS_ACTIVE="-"
  if [[ -f "$DB_FILE" ]]; then
    DB_SIZE="$(du -h "$DB_FILE" 2>/dev/null | cut -f1)"
    if command -v sqlite3 >/dev/null 2>&1; then
      DB_PASSWORD="$(sqlite3 "$DB_FILE" "SELECT value FROM app_config WHERE key='password';" 2>/dev/null || true)"
      SESSIONS_TOTAL="$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM command_sessions;" 2>/dev/null || echo '-')"
      SESSIONS_ACTIVE="$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM command_sessions WHERE archived=0;" 2>/dev/null || echo '-')"
    fi
  fi

  local sess_dir="$(dirname "$CONFIG_PATH")/sessions"
  if [[ -d "$sess_dir" ]]; then
    SESSIONS_DISK="$(du -sh "$sess_dir" 2>/dev/null | cut -f1)"
  else
    SESSIONS_DISK="-"
  fi

  if [[ -n "${WAND_BIN:-}" ]] && [[ -x "$WAND_BIN" ]]; then
    local global_pkg_json="$(dirname "$(dirname "$WAND_BIN")")/lib/node_modules/@co0ontty/wand/package.json"
    if [[ -f "$global_pkg_json" ]]; then
      INSTALLED_VERSION="$(node -e "process.stdout.write(require('$global_pkg_json').version)" 2>/dev/null || echo '?')"
    fi
  fi
  REPO_VERSION="$(node -e "process.stdout.write(require('$REPO_ROOT/package.json').version)" 2>/dev/null || echo '?')"
  INSTALLED_VERSION="${INSTALLED_VERSION:-未安装}"
}

# ── TUI 主面板 ───────────────────────────────────────────────────────
print_panel() {
  collect_runtime

  local status_dot status_text
  case "$SVC_ACTIVE" in
    active)   status_dot="${C_GREEN}●${C_RESET}"; status_text="${C_GREEN}active${C_RESET}" ;;
    failed)   status_dot="${C_RED}●${C_RESET}";   status_text="${C_RED}failed${C_RESET}" ;;
    inactive) status_dot="${C_DIM}○${C_RESET}";   status_text="${C_DIM}inactive${C_RESET}" ;;
    *)        status_dot="${C_YELLOW}●${C_RESET}"; status_text="${C_YELLOW}${SVC_ACTIVE}${C_RESET}" ;;
  esac
  local enabled_text
  case "$SVC_ENABLED" in
    enabled)  enabled_text="${C_GREEN}✓ enabled${C_RESET} ${C_DIM}(开机自启)${C_RESET}" ;;
    disabled) enabled_text="${C_YELLOW}✗ disabled${C_RESET}" ;;
    *)        enabled_text="${C_DIM}${SVC_ENABLED}${C_RESET}" ;;
  esac

  local version_line="${C_BOLD}${REPO_VERSION}${C_RESET}"
  if [[ "$INSTALLED_VERSION" != "$REPO_VERSION" ]] && [[ "$INSTALLED_VERSION" != "未安装" ]]; then
    version_line="${C_BOLD}${REPO_VERSION}${C_RESET}  ${C_DIM}(repo)${C_RESET}  ←  ${C_YELLOW}${INSTALLED_VERSION}${C_RESET} ${C_DIM}(installed, 待 ./start.sh)${C_RESET}"
  elif [[ "$INSTALLED_VERSION" == "$REPO_VERSION" ]]; then
    version_line="${C_BOLD}${REPO_VERSION}${C_RESET}  ${C_DIM}(repo == installed)${C_RESET}"
  else
    version_line="${C_BOLD}${REPO_VERSION}${C_RESET}  ${C_YELLOW}(repo, 尚未 install)${C_RESET}"
  fi

  echo
  echo -e "${C_MAGENTA}${C_BOLD}  W A N D${C_RESET}    ${C_DIM}${SCOPE}-systemd dev shell${C_RESET}"
  echo

  section "Service"
  row "Status"   "${status_dot} ${status_text}    PID ${SVC_PID}    uptime ${SVC_UPTIME}    mem ${SVC_MEM}"
  row "Boot"     "${enabled_text}"
  row "Scope"    "${C_BOLD}${SCOPE}${C_RESET}    ${C_DIM}(--user 切换到 user 级)${C_RESET}"
  row "Unit"     "${C_DIM}${UNIT_FILE}${C_RESET}"
  row "Binary"   "${WAND_BIN:-未安装}"
  row "Version"  "${version_line}"
  echo

  section "Access"
  row "Local"    "${C_CYAN}${PROTO}://127.0.0.1:${PORT}/${C_RESET}"
  [[ -n "$LAN_IP" ]] && row "LAN" "${C_CYAN}${PROTO}://${LAN_IP}:${PORT}/${C_RESET}"
  [[ -n "$DB_PASSWORD" ]] && row "Password" "${C_YELLOW}${DB_PASSWORD}${C_RESET}"
  echo

  section "Storage"
  row "Config"   "$CONFIG_PATH"
  row "SQLite"   "$DB_FILE  ${C_DIM}(${DB_SIZE})${C_RESET}"
  row "Sessions" "${SESSIONS_ACTIVE} active / ${SESSIONS_TOTAL} total  ${C_DIM}(disk: ${SESSIONS_DISK})${C_RESET}"
  echo

  section "Recent logs"
  if "${JOURNALCTL[@]}" -n 6 --no-pager -o cat 2>/dev/null | head -6 | sed "s/^/  ${C_DIM}/" | sed "s/$/${C_RESET}/"; then
    :
  else
    echo -e "  ${C_DIM}(no logs)${C_RESET}"
  fi
  echo

  section "Commands"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh"            "build + pack + install + service:install/restart（默认 system）"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh --user"     "改装 user-level service（不需要 root）"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh --attach"   "${C_YELLOW}接入运行中 service 的 TUI${C_RESET}（Ctrl-C 只退 TUI）"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh --no-build" "改前端 js/css 时跳过 tsc 加速"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh --restart"  "只重启，不重新打包（含 pkill 兜底）"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh --status"   "再次打印本面板（不动 service）"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh --logs"     "tail journal（Ctrl-C 退本 tail）"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh --stop"     "停 service"
  printf "  ${C_CYAN}%-24s${C_RESET} %s\n" "./start.sh --uninstall" "完整卸载（wand service:uninstall + npm uninstall）"
  echo
  echo -e "  ${C_DIM}service 跑在 ${SCOPE}-level systemd 下，本脚本退出 / Ctrl-C 都不会停服。${C_RESET}"
  if [[ "$SCOPE" == "user" ]]; then
    echo -e "  ${C_DIM}登出后想保持运行：loginctl enable-linger \$USER${C_RESET}"
  fi
  echo -e "  ${C_DIM}浏览器刷不到改动: Cmd/Ctrl+Shift+R 硬刷；PWA 还要 DevTools → Application → SW → Unregister${C_RESET}"
  echo
}

# ── 子命令分发 ───────────────────────────────────────────────────────
case "$ACTION" in
  attach)
    attach_to_running_service
    ;;
  status)
    WAND_BIN="$(detect_wand_bin)"
    print_panel
    exit 0
    ;;
  logs)
    msg "Ctrl-C 退出本 tail，service 不受影响"
    exec "${JOURNALCTL[@]}" -f --no-pager
    ;;
  stop)
    WAND_BIN="$(detect_wand_bin)"
    if [[ -n "$WAND_BIN" ]]; then
      msg "$SUDO $WAND_BIN service:stop $SCOPE_FLAG"
      $SUDO "$WAND_BIN" service:stop "$SCOPE_FLAG" || true
    else
      msg "${SYSTEMCTL[*]} stop $SERVICE_NAME"
      $SUDO "${SYSTEMCTL[@]}" stop "$SERVICE_NAME" 2>&1 || true
    fi
    ok "已停"
    exit 0
    ;;
  restart-only)
    WAND_BIN="$(detect_wand_bin)"
    [[ -n "$WAND_BIN" ]] || die "未找到全局 wand 命令，先跑 ./start.sh 装一次。"
    ensure_service_installed_and_running "$WAND_BIN"
    print_panel
    exit 0
    ;;
  uninstall)
    msg "wand service:uninstall + npm uninstall -g @co0ontty/wand"
    WAND_BIN="$(detect_wand_bin)"
    if [[ -n "$WAND_BIN" ]]; then
      $SUDO "$WAND_BIN" service:uninstall "$SCOPE_FLAG" 2>&1 || true
    else
      $SUDO "${SYSTEMCTL[@]}" stop "$SERVICE_NAME" 2>&1 || true
      $SUDO "${SYSTEMCTL[@]}" disable "$SERVICE_NAME" 2>&1 || true
      $SUDO rm -f "$UNIT_FILE"
      $SUDO "${SYSTEMCTL[@]}" daemon-reload 2>&1 || true
    fi
    npm unlink 2>&1 || npm uninstall -g @co0ontty/wand 2>&1 || true
    ok "卸载完成"
    exit 0
    ;;
esac

# ── dev 版本号管理 ──────────────────────────────────────────────────
# 构建前设 dev 版本号，脚本退出时无论如何都恢复
ORIG_VERSION="$(node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null)"
# 如果当前版本已带 -dev（上次中断没恢复），先剥掉
ORIG_VERSION="${ORIG_VERSION%%-dev.*}"
DEV_VERSION="${ORIG_VERSION}-dev.$(date +%m%d%H%M)"

restore_version() {
  npm version "$ORIG_VERSION" --no-git-tag-version --allow-same-version >/dev/null 2>&1 || true
}
trap 'restore_version' EXIT

# Ctrl-C 在 install 阶段安全：service 还在跑旧二进制不会受影响。
on_install_sigint() {
  echo
  ok "已中止。service 不受影响（仍跑旧二进制）。"
  ok "想重新来一次：./start.sh"
  exit 130
}
trap 'restore_version; on_install_sigint' INT

# ── ① 构建 ───────────────────────────────────────────────────────────
if [[ "$DO_BUILD" == "1" ]]; then
  msg "版本号: $ORIG_VERSION → $DEV_VERSION"
  npm version "$DEV_VERSION" --no-git-tag-version --allow-same-version >/dev/null 2>&1
  msg "npm run build"
  npm run build
  ok "build 完成 ($DEV_VERSION)"
else
  [[ -f "$REPO_ROOT/dist/cli.js" ]] || die "--no-build 但 dist/cli.js 不存在。"
  if [[ -n "$(find "$REPO_ROOT/src" -type f -newer "$REPO_ROOT/dist/cli.js" -print -quit 2>/dev/null)" ]]; then
    warn "检测到 src/ 中有比 dist/cli.js 更新的文件，--no-build 可能装的是旧代码"
  fi
fi

# ── ② npm link（可跳过） ─────────────────────────────────────────────
# 用 npm link 取代 npm pack + npm install -g：创建符号链接而非复制，
# 后续只要 npm run build + service:restart 就够，不用每次重打包。
if [[ "$DO_INSTALL" == "1" ]]; then
  if service_installed; then
    $SUDO "${SYSTEMCTL[@]}" stop "$SERVICE_NAME" 2>/dev/null || true
  fi
  cleanup_stale_wand
  msg "npm link（全局 wand → $(pwd)）"
  npm link 2>&1 | tail -3
  ok "npm link 完成"
fi

# link / install 之后才能确定 wand 位置
WAND_BIN="$(detect_wand_bin)"
[[ -n "$WAND_BIN" ]] || die "npm link 完成后仍未在 PATH 里找到 wand，检查 \$PATH / npm prefix。"

# ── ④ 配置：确保 config 存在；按需改 port ────────────────────────────
if [[ ! -f "$CONFIG_PATH" ]]; then
  msg "config 不存在，初始化: $WAND_BIN init -c $CONFIG_PATH"
  mkdir -p "$(dirname "$CONFIG_PATH")"
  "$WAND_BIN" init -c "$CONFIG_PATH" >/dev/null
fi
if [[ -n "$PORT_OVERRIDE" ]]; then
  msg "$WAND_BIN config:set port $PORT_OVERRIDE -c $CONFIG_PATH"
  "$WAND_BIN" config:set port "$PORT_OVERRIDE" -c "$CONFIG_PATH" >/dev/null
fi

# ── ⑤ 装 / 重启服务（走 wand service:* ＝ src/tui/commands.ts 同一套） ──
on_restart_sigint() {
  echo
  warn "重启阶段被中断。service 可能处于未定义状态。"
  warn "请手动跑：./start.sh --restart  把它重新拉起来。"
  exit 130
}
trap on_restart_sigint INT

ensure_service_installed_and_running "$WAND_BIN"

trap - INT

# ── ⑥ 全景面板 ───────────────────────────────────────────────────────
print_panel
