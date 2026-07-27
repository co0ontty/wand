#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

read_wand_password() {
  if command -v wand &>/dev/null; then
    wand config:password 2>/dev/null && return 0
  fi
  node <<'NODE' 2>/dev/null
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const configPath = path.join(os.homedir(), ".wand", "config.json");
let configPassword = "";
try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (typeof config.password === "string" && config.password.length > 0) {
    configPassword = config.password;
  }
} catch {}

try {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = path.join(path.dirname(configPath), "wand.db");
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get("password");
    db.close();
    if (row && typeof row.value === "string" && row.value.length > 0) {
      console.log(row.value);
      process.exit(0);
    }
  }
} catch {}

if (configPassword) {
  console.log(configPassword);
  process.exit(0);
}
process.exit(1);
NODE
}

REQUIRED_NODE_MAJOR=22

# --- Check Node.js ---
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/^v//')
  NODE_MAJOR=${NODE_VERSION%%.*}
  if (( NODE_MAJOR < REQUIRED_NODE_MAJOR )); then
    warn "Node.js v${NODE_VERSION} detected, but v${REQUIRED_NODE_MAJOR}+ is required."
    NEED_NODE=1
  else
    info "Node.js v${NODE_VERSION} found."
    NEED_NODE=0
  fi
else
  warn "Node.js not found."
  NEED_NODE=1
fi

if (( NEED_NODE )); then
  info "Installing Node.js v${REQUIRED_NODE_MAJOR} via NodeSource..."
  if command -v curl &>/dev/null; then
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
  elif command -v wget &>/dev/null; then
    wget -qO- "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
  else
    error "curl or wget is required to install Node.js."
  fi
  sudo apt-get install -y nodejs || error "Failed to install Node.js. Please install Node.js >= ${REQUIRED_NODE_MAJOR} manually."
  info "Node.js $(node -v) installed."
fi

# --- Pre-install cleanup ---
# 如果 wand 设为开机自启或正在运行，npm 全局更新时 rename 旧包目录会失败，
# 留下 `.wand-XXXXXX` 残留目录；之后每次 `npm install -g` 都会因 dest 已存在
# 报 ENOTEMPTY。这里先停掉正在跑的进程，再清理残留，让安装幂等可重试。
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo &>/dev/null; then
  SUDO="sudo"
fi

info "Stopping running wand processes (if any)..."
# 同时检测系统级和用户级 systemd unit，升级后要按对应 scope 重新生成
# unit 文件（详见下面 WAND_SYSTEMD_SCOPE 的用途）。
WAND_SYSTEMD_SCOPE=""
if command -v systemctl &>/dev/null; then
  for unit in wand wand.service; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}"; then
      $SUDO systemctl stop "$unit" 2>/dev/null || true
      WAND_SYSTEMD_UNIT="$unit"
      WAND_SYSTEMD_SCOPE="system"
    fi
  done
  # 用户级 unit（XDG_RUNTIME_DIR 有时不会一直在；用 --user list-unit-files
  # 安全地探测，失败就当没有）。
  if [ -z "$WAND_SYSTEMD_SCOPE" ] && systemctl --user list-unit-files 2>/dev/null | grep -q "^wand"; then
    systemctl --user stop wand.service 2>/dev/null || true
    WAND_SYSTEMD_UNIT="wand.service"
    WAND_SYSTEMD_SCOPE="user"
  fi
fi
pkill -f "wand web" 2>/dev/null || true
pkill -f "wand/dist/cli\\.js" 2>/dev/null || true
# 给 OS 一点时间释放文件句柄
sleep 1

NPM_ROOT="$(npm root -g 2>/dev/null || true)"
if [ -n "$NPM_ROOT" ] && [ -d "$NPM_ROOT/@co0ontty" ]; then
  LEFTOVER=$(find "$NPM_ROOT/@co0ontty" -maxdepth 1 -name ".wand-*" -type d 2>/dev/null || true)
  if [ -n "$LEFTOVER" ]; then
    warn "Cleaning leftover npm rename dirs:"
    echo "$LEFTOVER" | while read -r d; do echo "  - $d"; done
    echo "$LEFTOVER" | xargs $SUDO rm -rf
  fi
fi

# --- Install wand ---
info "Installing @co0ontty/wand..."
npm install -g @co0ontty/wand || error "npm install failed."

# --- Init (needed before service:install reads config) ---
info "Initializing wand..."
wand init
if WAND_INITIAL_PASSWORD="$(read_wand_password)"; then
  info "Wand login password: ${GREEN}${WAND_INITIAL_PASSWORD}${NC}"
  info "You can view it again with: ${GREEN}wand config:password${NC}"
else
  warn "Unable to read Wand login password. Try: wand config:password"
fi

# --- Re-register systemd unit if we stopped one (升级场景) ---
# 关键修复：以前这里只 `systemctl start`，但 unit 文件里的 `Environment=PATH=...`
# 是上次 `wand service:install` 那一刻烧的快照。用户切 node 版本 / 把 claude 装
# 到新位置后，老 unit 的 PATH 找不到 claude → "command not found"。
# 现在改成重新跑 `wand service:install`：它会按当前 shell 的 PATH 重新生成 unit
# 文件，然后 daemon-reload + enable --now，等价于 stop+regen+start。
# 升级成功后置 SKIP_INSTALL_MENU=1，跳过下面的"选启动方式"交互（用户本来就在用服务）。
SKIP_INSTALL_MENU=0
if [ -n "${WAND_SYSTEMD_UNIT:-}" ]; then
  if [ "$WAND_SYSTEMD_SCOPE" = "user" ]; then
    info "Re-registering ${WAND_SYSTEMD_UNIT} (user scope) to refresh baked-in PATH..."
    if wand service:install --user; then
      SKIP_INSTALL_MENU=1
    else
      warn "wand service:install --user 失败，回退到 systemctl --user start"
      systemctl --user start "$WAND_SYSTEMD_UNIT" 2>/dev/null \
        || warn "也起不来，请手动跑 'wand service:install --user'"
    fi
  else
    info "Re-registering ${WAND_SYSTEMD_UNIT} to refresh baked-in PATH..."
    if $SUDO wand service:install; then
      SKIP_INSTALL_MENU=1
    else
      warn "wand service:install 失败，回退到 systemctl start"
      $SUDO systemctl start "$WAND_SYSTEMD_UNIT" 2>/dev/null \
        || warn "也起不来，请手动跑 '${SUDO:+sudo }wand service:install'"
    fi
  fi
fi

# --- Choose run mode ---
# 装完后让用户选启动方式。Root 看到 2 项,非 root 看到 3 项:
#   service  → 系统级 systemd / launchd（root 装；非 root 会 sudo 提权要密码）
#   user     → 用户级 systemd / launchd（只对非 root 显示;不需要密码;登出会被回收）
#   oneshot  → 不装服务,以后手动跑 `wand web`
#
# 默认 = service（用户敲回车直接走推荐路径）
# 覆盖两类调用方式都给合理结果:
#   1) `bash install.sh`     ← 交互终端,read 从 /dev/tty 拿键盘输入
#   2) `bash <(curl ...)`    ← 一键脚本,stdin 是管道,read 拿不到 → 走默认 service
# 想完全静默指定:  WAND_INSTALL_MODE=oneshot bash install.sh
echo ""
IS_ROOT=0
[ "$(id -u)" -eq 0 ] && IS_ROOT=1

choose_install_mode() {
  local mode="${WAND_INSTALL_MODE:-}"
  if [ -n "$mode" ]; then
    echo "$mode"
    return
  fi
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    # 非交互且没法读 tty:默认装系统服务（非 root 时会 sudo 提权）
    echo "service"
    return
  fi
  echo "如何启动 wand？" >&2
  if [ "$IS_ROOT" -eq 1 ]; then
    echo "  1) 安装为系统服务（推荐）— 系统级 systemd / launchd,开机自启、崩了自重启" >&2
    echo "  2) 单次启动 — 之后手动跑 'wand web'" >&2
  else
    echo "  1) 安装为系统服务（推荐）— 系统级,开机自启,${YELLOW}要 sudo 密码${NC}" >&2
    echo "  2) 注册为用户服务 — 用户级 systemd / launchd,${YELLOW}不要 sudo${NC},但登出会被回收" >&2
    echo "  3) 单次启动 — 不注册服务,之后手动跑 'wand web'" >&2
  fi
  local choice
  read -r -p "选择 [1]: " choice </dev/tty 2>/dev/null || choice=""
  choice="${choice:-1}"
  if [ "$IS_ROOT" -eq 1 ]; then
    case "$choice" in
      2|oneshot|once) echo "oneshot" ;;
      *) echo "service" ;;
    esac
  else
    case "$choice" in
      2|user)            echo "user" ;;
      3|oneshot|once)    echo "oneshot" ;;
      *)                 echo "service" ;;
    esac
  fi
}

if [ "$SKIP_INSTALL_MENU" = "1" ]; then
  # 升级场景：老服务已被 wand service:install 重新生成 + enable --now，没必要
  # 再问用户怎么启动。直接打印升级完成 + 状态查询提示。
  echo ""
  if [ "$WAND_SYSTEMD_SCOPE" = "user" ]; then
    info "升级完成，用户级服务已用最新 PATH 重新注册并启动。"
    info "查看状态：${GREEN}wand service:status --user${NC}"
    info "看 日 志：${GREEN}wand service:logs --user${NC}"
  else
    info "升级完成，系统级服务已用最新 PATH 重新注册并启动。"
    info "查看状态：${GREEN}wand service:status${NC}"
    info "看 日 志：${GREEN}wand service:logs${NC}"
  fi
  info "接入 TUI：${GREEN}wand web${NC}"
  exit 0
fi

MODE=$(choose_install_mode)

case "$MODE" in
  service)
    # 系统级。Root 直接装;非 root 走 sudo（首次会让用户输密码）
    info "Installing wand as a system-wide systemd / launchd service..."
    if [ -n "$SUDO" ]; then
      info "需要 sudo 密码以写入 /etc/systemd/system/:"
    fi
    if $SUDO wand service:install; then
      info "服务已注册并在后台运行（开机自启）。"
      echo ""
      info "查看状态：${GREEN}wand service:status${NC}    ${SUDO:+(读取不要 sudo)}"
      info "看 日 志：${GREEN}wand service:logs${NC}"
      info "停止服务：${GREEN}${SUDO:+sudo }wand service:stop${NC}"
      info "卸载服务：${GREEN}${SUDO:+sudo }wand service:uninstall${NC}"
      echo ""
      info "随时打开 TUI 接入运行中的服务：${GREEN}wand web${NC}"
    else
      warn "服务安装失败。常见原因：sudo 密码错、systemd 不可用。"
      warn "想跳过 root 走用户级安装：${GREEN}wand service:install --user${NC}"
      warn "或先用 ${GREEN}wand web${NC} 启动一次试试。"
    fi
    ;;
  user)
    # 用户级 systemd / launchd,不要 sudo
    info "Installing wand as a user-level service (no sudo)..."
    if wand service:install --user; then
      info "用户级服务已注册并在后台运行。"
      if [ "$(uname)" = "Linux" ]; then
        warn "⚠ 用户登出后服务会被回收。想保持登出后也运行:"
        info "  ${GREEN}loginctl enable-linger \$USER${NC}"
      fi
      echo ""
      info "查看状态：${GREEN}wand service:status --user${NC}"
      info "看 日 志：${GREEN}wand service:logs --user${NC}"
      info "停止服务：${GREEN}wand service:stop --user${NC}"
      info "卸载服务：${GREEN}wand service:uninstall --user${NC}"
      echo ""
      info "随时打开 TUI 接入运行中的服务：${GREEN}wand web${NC}"
    else
      warn "用户级服务安装失败（可能 user-systemd 没起来，或 XDG_RUNTIME_DIR 没设）。"
      warn "可以先用 ${GREEN}wand web${NC} 启动试试。"
    fi
    ;;
  oneshot|*)
    echo ""
    info "Installation complete! Run ${GREEN}wand web${NC} to start."
    if [ "$IS_ROOT" -eq 1 ]; then
      info "想以后改成后台服务：${GREEN}wand service:install${NC}"
    else
      info "想以后改成系统级服务：${GREEN}sudo wand service:install${NC}"
      info "或不想用 sudo：       ${GREEN}wand service:install --user${NC}（登出会被回收）"
    fi
    ;;
esac
