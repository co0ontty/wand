#!/bin/bash
#
# start.sh - build a local npm package, install it into the active wand prefix,
# then restart the current service.
#
# Usage:
#   ./start.sh                # build -> npm pack/install -> restart current service
#   ./start.sh --user         # force user service scope
#   ./start.sh --system       # force system service scope
#   ./start.sh --attach       # attach to the running instance TUI
#   ./start.sh --no-build     # skip build, use existing dist/
#   ./start.sh --skip-install # skip npm install, only restart
#   ./start.sh --restart      # only restart current service
#   ./start.sh --status       # print status
#   ./start.sh --logs         # follow service logs where supported
#   ./start.sh --stop         # stop service
#   ./start.sh --uninstall    # uninstall service and global package
#   ./start.sh --port 8443    # update config port before restart
#
# Scope defaults to "auto": use the running service first, then an installed
# service, then system scope for a first install.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

SERVICE_NAME="wand"
LAUNCHD_LABEL="com.wand.web"
CONFIG_PATH="${WAND_CONFIG:-$HOME/.wand/config.json}"

if [[ -t 1 ]]; then
  C_DIM="\033[2m"; C_RED="\033[31m"; C_GREEN="\033[32m"
  C_YELLOW="\033[33m"; C_CYAN="\033[36m"; C_MAGENTA="\033[35m"
  C_BOLD="\033[1m"; C_RESET="\033[0m"
else
  C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_MAGENTA=""; C_BOLD=""; C_RESET=""
fi
msg()  { echo -e "${C_CYAN}->${C_RESET} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!${C_RESET} $*"; }
die()  { echo -e "${C_RED}x${C_RESET} $*" >&2; exit 1; }

ACTION="install-and-restart"
DO_BUILD=1
DO_INSTALL=1
PORT_OVERRIDE=""
SCOPE="auto"

print_help() {
  awk '
    NR == 1 { next }
    /^#($| )/ { sub(/^# ?/, ""); print; next }
    /^$/ { print; next }
    { exit }
  ' "$0"
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
    --port)         PORT_OVERRIDE="${2:-}"; [[ -n "$PORT_OVERRIDE" ]] || die "--port 需要端口值"; shift 2 ;;
    --user)         SCOPE="user"; shift ;;
    --system)       SCOPE="system"; shift ;;
    -h|--help)      print_help; exit 0 ;;
    *) die "未知参数: $1（试试 --help）" ;;
  esac
done

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Linux)  BACKEND="systemd"; command -v systemctl >/dev/null 2>&1 || die "未找到 systemctl。" ;;
  Darwin) BACKEND="launchd"; command -v launchctl >/dev/null 2>&1 || die "未找到 launchctl。" ;;
  *)      die "当前平台 $OS_NAME 暂不支持 service 管理。" ;;
esac

NODE_BIN="$(command -v node 2>/dev/null || true)"
NPM_BIN="$(command -v npm 2>/dev/null || true)"
[[ -n "$NODE_BIN" ]] || die "未找到 node。"
[[ -n "$NPM_BIN" ]] || die "未找到 npm。"

service_file_for() {
  local scope="$1"
  if [[ "$BACKEND" == "systemd" ]]; then
    [[ "$scope" == "user" ]] && echo "$HOME/.config/systemd/user/${SERVICE_NAME}.service" || echo "/etc/systemd/system/${SERVICE_NAME}.service"
  else
    [[ "$scope" == "user" ]] && echo "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist" || echo "/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist"
  fi
}

is_scope_running() {
  local scope="$1"
  if [[ "$BACKEND" == "systemd" ]]; then
    if [[ "$scope" == "user" ]]; then
      systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null
    else
      systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null
    fi
  else
    local domain
    [[ "$scope" == "user" ]] && domain="gui/$(id -u)/${LAUNCHD_LABEL}" || domain="system/${LAUNCHD_LABEL}"
    launchctl print "$domain" 2>/dev/null | grep -q "state = running"
  fi
}

running_scope_from_process() {
  local owner
  owner="$(ps ax -o user= -o command= | awk -v cfg="$CONFIG_PATH" '
    index($0, cfg) == 0 { next }
    !($0 ~ /(^|[[:space:]])wand([[:space:]]|$)/ || $0 ~ /\/wand([[:space:]]|$)/ || $0 ~ /\/cli\.js web/ || $0 ~ /src\/cli\.ts web/) { next }
    { print $1; exit }
  ' || true)"
  case "$owner" in
    root) echo "system" ;;
    "") ;;
    *) echo "user" ;;
  esac
}

running_pid_from_process() {
  ps ax -o pid= -o command= | awk -v cfg="$CONFIG_PATH" '
    index($0, cfg) == 0 { next }
    !($0 ~ /(^|[[:space:]])wand([[:space:]]|$)/ || $0 ~ /\/wand([[:space:]]|$)/ || $0 ~ /\/cli\.js web/ || $0 ~ /src\/cli\.ts web/) { next }
    { print $1; exit }
  ' || true
}

resolve_scope() {
  if [[ "$SCOPE" != "auto" ]]; then
    echo "$SCOPE"
    return
  fi
  local running_scope
  running_scope="$(running_scope_from_process)"
  if [[ -n "$running_scope" ]]; then echo "$running_scope"; return; fi
  if is_scope_running "user"; then echo "user"; return; fi
  if is_scope_running "system"; then echo "system"; return; fi
  if [[ -f "$(service_file_for "system")" ]]; then echo "system"; return; fi
  if [[ -f "$(service_file_for "user")" ]]; then echo "user"; return; fi
  echo "system"
}

SCOPE="$(resolve_scope)"
SCOPE_FLAG="--${SCOPE}"
UNIT_FILE="$(service_file_for "$SCOPE")"

USE_SUDO=0
if [[ "$SCOPE" == "system" ]] && [[ "$(id -u)" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "system scope 需要 root，但找不到 sudo。可用 --user。"
  USE_SUDO=1
  warn "当前不是 root，system scope 会用 sudo"
fi

if [[ "$USE_SUDO" == "1" && "$ACTION" != "status" && "$ACTION" != "logs" && "$ACTION" != "attach" && ! -t 0 ]]; then
  sudo -n true 2>/dev/null || die "system scope 需要 sudo，但当前没有可交互终端。请在终端里运行，或加 --user。"
fi

sudo_prefix() {
  [[ "$USE_SUDO" == "1" ]] && printf "sudo "
  return 0
}

run_privileged() {
  if [[ "$USE_SUDO" == "1" ]]; then
    sudo "$@"
  else
    "$@"
  fi
}

service_installed() { [[ -f "$UNIT_FILE" ]]; }
detect_wand_bin() { command -v wand 2>/dev/null || true; }

prefix_from_wand_bin() {
  local bin="$1"
  if [[ "$bin" == */bin/wand ]]; then
    dirname "$(dirname "$bin")"
  else
    npm prefix -g
  fi
}

node_for_prefix() {
  local prefix="$1"
  if [[ -x "$prefix/bin/node" ]]; then
    echo "$prefix/bin/node"
  else
    echo "$NODE_BIN"
  fi
}

refresh_wand_runtime() {
  WAND_BIN="$(detect_wand_bin)"
  if [[ -n "$WAND_BIN" ]]; then
    WAND_PREFIX="$(prefix_from_wand_bin "$WAND_BIN")"
  else
    WAND_PREFIX="$(npm prefix -g)"
    WAND_BIN="$WAND_PREFIX/bin/wand"
  fi
  NODE_FOR_WAND="$(node_for_prefix "$WAND_PREFIX")"
}

run_wand() {
  "$NODE_FOR_WAND" "$WAND_BIN" "$@"
}

latest_tag_version() {
  local tag
  tag="$(git tag --sort=-v:refname --list 'v*' | head -1 | sed 's/^v//' || true)"
  if [[ -z "$tag" ]]; then
    tag="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
  fi
  echo "$tag"
}

config_value() {
  local key="$1" fallback="$2"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, key, fallback] = process.argv.slice(1);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      process.stdout.write(String(data[key] ?? fallback));
    } catch {
      process.stdout.write(String(fallback));
    }
  ' "$CONFIG_PATH" "$key" "$fallback"
}

cleanup_stale_wand() {
  local target_port="${PORT_OVERRIDE:-$(config_value port 8443)}"
  if command -v lsof >/dev/null 2>&1; then
    local port_pids
    port_pids="$(lsof -nP -tiTCP:"$target_port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$port_pids" ]]; then
      warn "端口 $target_port 被占用，kill: $(echo "$port_pids" | tr '\n' ' ')"
      run_privileged kill $port_pids 2>/dev/null || true
      sleep 1
    fi
  fi

  local stale_pids
  stale_pids="$(ps ax -o pid= -o command= | awk -v self="$$" -v cfg="$CONFIG_PATH" '
    $1 == self { next }
    !($0 ~ /\/wand web/ || $0 ~ /\/cli\.js web/ || $0 ~ /src\/cli\.ts web/) { next }
    index($0, "-c " cfg) || index($0, "--config " cfg) || $0 !~ /(^|[[:space:]])(-c|--config)[[:space:]]/ { print $1 }
  ' || true)"
  if [[ -n "$stale_pids" ]]; then
    warn "残留 wand 进程，kill: $(echo "$stale_pids" | tr '\n' ' ')"
    run_privileged kill $stale_pids 2>/dev/null || true
    sleep 1
  fi
  local config_dir
  config_dir="$(dirname "$CONFIG_PATH")"
  if [[ -S "$config_dir/wand.sock" || -e "$config_dir/wand.pid" ]]; then
    run_privileged rm -f "$config_dir/wand.sock" "$config_dir/wand.pid" 2>/dev/null || true
  fi
  return 0
}

repair_global_package_permissions() {
  local scope_dir="$WAND_PREFIX/lib/node_modules/@co0ontty"
  [[ -e "$scope_dir" ]] || return 0
  if ! find "$scope_dir" -maxdepth 3 \( ! -user "$(id -u)" -o ! -group "$(id -g)" \) -print -quit | grep -q .; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    die "$scope_dir 含有非当前用户拥有的 npm 文件，但找不到 sudo。请手动执行: chown -R $(id -un):$(id -gn) $scope_dir"
  fi
  if [[ ! -t 0 ]] && ! sudo -n true 2>/dev/null; then
    die "$scope_dir 含有非当前用户拥有的 npm 文件，当前环境不能输入 sudo 密码。请在终端执行: sudo chown -R $(id -un):$(id -gn) $scope_dir"
  fi
  warn "修复 npm 全局包目录权限: $scope_dir"
  sudo chown -R "$(id -u):$(id -g)" "$scope_dir"
}

cleanup_npm_package_temps() {
  local scope_dir="$WAND_PREFIX/lib/node_modules/@co0ontty"
  [[ -d "$scope_dir" ]] || return 0
  local temp
  for temp in "$scope_dir"/.wand-*; do
    [[ -e "$temp" ]] || continue
    [[ "$(basename "$temp")" == .wand-* ]] || continue
    warn "清理 npm 残留临时目录: $temp"
    rm -rf "$temp"
  done
}

ensure_service_installed_and_running() {
  [[ -x "$WAND_BIN" || -f "$WAND_BIN" ]] || die "找不到 wand: $WAND_BIN"

  if service_installed; then
    msg "$(sudo_prefix)$NODE_FOR_WAND $WAND_BIN service:stop $SCOPE_FLAG"
    run_privileged "$NODE_FOR_WAND" "$WAND_BIN" service:stop "$SCOPE_FLAG" >/dev/null 2>&1 || true
    cleanup_stale_wand
    msg "$(sudo_prefix)$NODE_FOR_WAND $WAND_BIN service:install $SCOPE_FLAG"
    run_privileged "$NODE_FOR_WAND" "$WAND_BIN" service:install "$SCOPE_FLAG" || die "service:install 失败"
    ok "服务 unit/plist 已重写并启动"
  else
    msg "未发现 $BACKEND $SCOPE service，开始首次注册"
    msg "$(sudo_prefix)$NODE_FOR_WAND $WAND_BIN service:install $SCOPE_FLAG"
    run_privileged "$NODE_FOR_WAND" "$WAND_BIN" service:install "$SCOPE_FLAG" || die "service:install 失败"
    ok "已注册并启动 wand $SCOPE service"
  fi
}

attach_to_running_service() {
  refresh_wand_runtime
  [[ -f "$WAND_BIN" || -x "$WAND_BIN" ]] || die "未找到 wand 命令；先跑 ./start.sh 安装一次。"
  echo
  echo -e "${C_BOLD}${C_YELLOW}! 正在 attach 到运行中的 wand 实例${C_RESET}"
  echo -e "  ${C_DIM}backend: $BACKEND    scope: $SCOPE    config: $CONFIG_PATH${C_RESET}"
  echo -e "  ${C_GREEN}Ctrl-C 只退出本 TUI，不会停掉 service${C_RESET}"
  echo
  exec "$NODE_FOR_WAND" "$WAND_BIN" web -c "$CONFIG_PATH"
}

service_state() {
  if [[ "$BACKEND" == "systemd" ]]; then
    local base=()
    [[ "$SCOPE" == "user" ]] && base=(--user)
    systemctl "${base[@]}" is-active "$SERVICE_NAME" 2>/dev/null || echo "unknown"
  else
    local domain out
    [[ "$SCOPE" == "user" ]] && domain="gui/$(id -u)/${LAUNCHD_LABEL}" || domain="system/${LAUNCHD_LABEL}"
    out="$(launchctl print "$domain" 2>/dev/null || true)"
    if grep -q "state = running" <<<"$out"; then
      echo "active"
    elif [[ -n "$(running_pid_from_process)" ]]; then
      echo "active"
    elif [[ -n "$out" ]]; then
      echo "inactive"
    else
      echo "unknown"
    fi
  fi
}

service_pid() {
  if [[ "$BACKEND" == "systemd" ]]; then
    local base=()
    [[ "$SCOPE" == "user" ]] && base=(--user)
    systemctl "${base[@]}" show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || echo "0"
  else
    local domain
    [[ "$SCOPE" == "user" ]] && domain="gui/$(id -u)/${LAUNCHD_LABEL}" || domain="system/${LAUNCHD_LABEL}"
    local pid
    pid="$(launchctl print "$domain" 2>/dev/null | awk '/pid = / { print $3; exit }' || true)"
    [[ -n "$pid" ]] || pid="$(running_pid_from_process)"
    echo "${pid:-0}"
  fi
}

installed_version() {
  local pkg="$WAND_PREFIX/lib/node_modules/@co0ontty/wand/package.json"
  [[ -f "$pkg" ]] || { echo "未安装"; return; }
  "$NODE_BIN" -e 'process.stdout.write(require(process.argv[1]).version)' "$pkg" 2>/dev/null || echo "?"
}

lan_ip() {
  if [[ "$BACKEND" == "systemd" ]]; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -vE '^(127\.|169\.254\.)' | head -1
  else
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  fi
}

print_recent_logs() {
  if [[ "$BACKEND" == "systemd" ]]; then
    local base=()
    [[ "$SCOPE" == "user" ]] && base=(--user)
    journalctl "${base[@]}" -u "$SERVICE_NAME" -n 6 --no-pager -o cat 2>/dev/null | sed "s/^/  /" || true
  else
    echo "  launchd 日志请用 Console.app；脚本 --logs 会打开 log stream。"
  fi
}

print_panel() {
  refresh_wand_runtime
  local state pid port https proto ip repo_ver inst_ver db_file
  state="$(service_state)"
  pid="$(service_pid)"
  port="$(config_value port 8443)"
  https="$(config_value https false)"
  proto="http"; [[ "$https" == "true" ]] && proto="https"
  ip="$(lan_ip)"
  repo_ver="$("$NODE_BIN" -e 'process.stdout.write(require("./package.json").version)' 2>/dev/null || echo "?")"
  inst_ver="$(installed_version)"
  db_file="$(dirname "$CONFIG_PATH")/wand.db"

  echo
  echo -e "${C_MAGENTA}${C_BOLD}  W A N D${C_RESET}    ${C_DIM}${BACKEND} local npm restart shell${C_RESET}"
  echo
  printf "  ${C_DIM}%-10s${C_RESET} %s (%s)  PID %s\n" "Service" "$state" "$SCOPE" "${pid:-0}"
  printf "  ${C_DIM}%-10s${C_RESET} %s\n" "Unit" "$UNIT_FILE"
  printf "  ${C_DIM}%-10s${C_RESET} %s\n" "Binary" "$WAND_BIN"
  printf "  ${C_DIM}%-10s${C_RESET} repo %s / installed %s\n" "Version" "$repo_ver" "$inst_ver"
  printf "  ${C_DIM}%-10s${C_RESET} %s://127.0.0.1:%s/\n" "Local" "$proto" "$port"
  [[ -n "$ip" ]] && printf "  ${C_DIM}%-10s${C_RESET} %s://%s:%s/\n" "LAN" "$proto" "$ip" "$port"
  printf "  ${C_DIM}%-10s${C_RESET} %s\n" "Config" "$CONFIG_PATH"
  printf "  ${C_DIM}%-10s${C_RESET} %s\n" "SQLite" "$db_file"
  echo
  echo -e "  ${C_DIM}Recent logs${C_RESET}"
  print_recent_logs
  echo
}

follow_logs() {
  if [[ "$BACKEND" == "systemd" ]]; then
    local base=()
    [[ "$SCOPE" == "user" ]] && base=(--user)
    exec journalctl "${base[@]}" -u "$SERVICE_NAME" -f --no-pager
  else
    exec log stream --style compact --predicate 'process == "node" || process == "wand"'
  fi
}

refresh_wand_runtime

case "$ACTION" in
  attach)
    attach_to_running_service
    ;;
  status)
    print_panel
    exit 0
    ;;
  logs)
    msg "Ctrl-C 退出本 log tail，service 不受影响"
    follow_logs
    ;;
  stop)
    if [[ -f "$WAND_BIN" || -x "$WAND_BIN" ]]; then
      msg "$(sudo_prefix)$NODE_FOR_WAND $WAND_BIN service:stop $SCOPE_FLAG"
      run_privileged "$NODE_FOR_WAND" "$WAND_BIN" service:stop "$SCOPE_FLAG" || true
    else
      warn "未找到 wand，无法通过 CLI stop"
    fi
    ok "已停"
    exit 0
    ;;
  restart-only)
    ensure_service_installed_and_running
    print_panel
    exit 0
    ;;
  uninstall)
    msg "wand service:uninstall + npm uninstall -g --prefix $WAND_PREFIX @co0ontty/wand"
    if [[ -f "$WAND_BIN" || -x "$WAND_BIN" ]]; then
      run_privileged "$NODE_FOR_WAND" "$WAND_BIN" service:uninstall "$SCOPE_FLAG" 2>&1 || true
    fi
    "$NPM_BIN" uninstall -g --prefix "$WAND_PREFIX" @co0ontty/wand 2>&1 || true
    ok "卸载完成"
    exit 0
    ;;
esac

PACKAGE_VERSION="$("$NODE_BIN" -e 'process.stdout.write(require("./package.json").version)' 2>/dev/null)"
RESTORE_VERSION="${PACKAGE_VERSION%%-dev.*}"
BASE_VERSION="$(latest_tag_version)"
[[ -n "$BASE_VERSION" ]] || BASE_VERSION="$RESTORE_VERSION"
DEV_VERSION="${BASE_VERSION}-dev.$(date +%Y%m%d%H%M)"
PACK_DIR=""

restore_version() {
  "$NPM_BIN" version "$RESTORE_VERSION" --no-git-tag-version --allow-same-version >/dev/null 2>&1 || true
  [[ -n "$PACK_DIR" && -d "$PACK_DIR" ]] && rm -rf "$PACK_DIR"
  return 0
}
trap restore_version EXIT
trap 'echo; warn "已中断。service 可能仍在跑旧版本。"; exit 130' INT

if [[ "$DO_BUILD" == "1" ]]; then
  if [[ -e "$REPO_ROOT/dist" && ! -w "$REPO_ROOT/dist" ]]; then
    command -v sudo >/dev/null 2>&1 || die "dist/ 不可写且找不到 sudo，请先修复权限: chown -R $(id -un):$(id -gn) $REPO_ROOT/dist"
    warn "dist/ 当前不可写，先归还给当前用户"
    sudo chown -R "$(id -u):$(id -g)" "$REPO_ROOT/dist"
  fi
  msg "版本号: package $RESTORE_VERSION, latest tag $BASE_VERSION -> $DEV_VERSION"
  "$NPM_BIN" version "$DEV_VERSION" --no-git-tag-version --allow-same-version >/dev/null 2>&1
  msg "WAND_BUILD_CHANNEL=beta npm run build"
  WAND_BUILD_CHANNEL=beta "$NPM_BIN" run build
  ok "build 完成 ($DEV_VERSION)"
else
  [[ -f "$REPO_ROOT/dist/cli.js" ]] || die "--no-build 但 dist/cli.js 不存在。"
  if [[ -n "$(find "$REPO_ROOT/src" -type f -newer "$REPO_ROOT/dist/cli.js" -print -quit 2>/dev/null)" ]]; then
    warn "检测到 src/ 中有比 dist/cli.js 更新的文件，--no-build 可能装的是旧代码"
  fi
fi

if [[ "$DO_INSTALL" == "1" ]]; then
  if service_installed && [[ -f "$WAND_BIN" || -x "$WAND_BIN" ]]; then
    run_privileged "$NODE_FOR_WAND" "$WAND_BIN" service:stop "$SCOPE_FLAG" >/dev/null 2>&1 || true
  fi
  cleanup_stale_wand

  PACK_DIR="$(mktemp -d)"
  msg "npm pack -> install -g --prefix $WAND_PREFIX"
  repair_global_package_permissions
  cleanup_npm_package_temps
  PACK_FILE="$("$NPM_BIN" pack --pack-destination "$PACK_DIR" | tail -1)"
  [[ -n "$PACK_FILE" && -f "$PACK_DIR/$PACK_FILE" ]] || die "npm pack 未产出 tarball"
  "$NPM_BIN" install -g --prefix "$WAND_PREFIX" "$PACK_DIR/$PACK_FILE" --no-audit --no-fund
  ok "本地 npm 包已安装到 $WAND_PREFIX"
  refresh_wand_runtime
fi

[[ -f "$WAND_BIN" || -x "$WAND_BIN" ]] || die "安装后仍找不到 wand: $WAND_BIN"

if [[ ! -f "$CONFIG_PATH" ]]; then
  msg "config 不存在，初始化: $CONFIG_PATH"
  mkdir -p "$(dirname "$CONFIG_PATH")"
  run_wand init -c "$CONFIG_PATH" >/dev/null
fi

if [[ -n "$PORT_OVERRIDE" ]]; then
  msg "wand config:set port $PORT_OVERRIDE -c $CONFIG_PATH"
  run_wand config:set port "$PORT_OVERRIDE" -c "$CONFIG_PATH" >/dev/null
fi

ensure_service_installed_and_running
trap - INT
print_panel
exit 0
