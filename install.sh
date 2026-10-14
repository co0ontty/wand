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
  local config_path="$1"
  if command -v wand &>/dev/null; then
    wand config:password -c "$config_path" 2>/dev/null && return 0
  fi
  node - "$config_path" <<'NODE' 2>/dev/null
const fs = require("node:fs");
const path = require("node:path");

const configPath = process.argv[2];
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

# A standalone downloaded install.sh has no .nvmrc beside it. In a checkout,
# use the same pin as build/CI; keep the standalone fallback in sync.
REQUIRED_NODE_VERSION="24.21.0"
NODE_VERSION_FILE="$(dirname "${BASH_SOURCE[0]}")/.nvmrc"
if [[ -f "$NODE_VERSION_FILE" ]]; then
  REQUIRED_NODE_VERSION="$(<"$NODE_VERSION_FILE")"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_TEMP_DIR=""
cleanup_install_temp() {
  if [ -n "$INSTALL_TEMP_DIR" ]; then rm -rf "$INSTALL_TEMP_DIR"; fi
}
trap cleanup_install_temp EXIT
ensure_install_temp() {
  if [ -z "$INSTALL_TEMP_DIR" ]; then INSTALL_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wand-install.XXXXXX")"; fi
}
if [ -f "$SCRIPT_DIR/scripts/update-node.sh" ]; then
  . "$SCRIPT_DIR/scripts/update-node.sh"
else
  ensure_install_temp
  curl -fLsS https://raw.githubusercontent.com/co0ontty/wand/master/scripts/update-node.sh -o "$INSTALL_TEMP_DIR/update-node.sh"
  . "$INSTALL_TEMP_DIR/update-node.sh"
fi

if ! wand_ensure_update_node "$REQUIRED_NODE_VERSION"; then
  if [ "$(uname -s)" = "Darwin" ]; then
    error "未找到兼容 Node.js；请先安装 Node.js >= ${REQUIRED_NODE_VERSION} 或配置 nvm，再重跑本入口。旧服务未修改。"
  fi
  info "Installing Node.js v${REQUIRED_NODE_VERSION} via NodeSource..."
  if command -v curl &>/dev/null; then
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_VERSION%%.*}.x" | sudo -E bash -
  elif command -v wget &>/dev/null; then
    wget -qO- "https://deb.nodesource.com/setup_${REQUIRED_NODE_VERSION%%.*}.x" | sudo -E bash -
  else
    error "curl or wget is required to install Node.js."
  fi
  sudo apt-get install -y nodejs || error "Failed to install Node.js. Please install Node.js >= ${REQUIRED_NODE_VERSION} manually."
  wand_use_existing_node "$REQUIRED_NODE_VERSION" || error "安装后的 Node.js 仍低于要求，旧服务未修改。"
fi
info "Node.js $(node -v) ready."

# Existing installations use an independent recovery runtime. Their installed
# updater may be broken or pinned to an old source/Node path.
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo &>/dev/null; then SUDO="sudo"; fi
NPM_ROOT_CHECK="$(npm root -g 2>/dev/null || true)"
CONFIG_PATH="${WAND_CONFIG_PATH:-$HOME/.wand/config.json}"
SERVICE_EXISTS=0
if [ "$(uname -s)" = "Darwin" ]; then
  if [ -f /Library/LaunchDaemons/com.wand.web.plist ] || [ -f "$HOME/Library/LaunchAgents/com.wand.web.plist" ]; then SERVICE_EXISTS=1; fi
else
  if [ -f /etc/systemd/system/wand.service ] || [ -f "$HOME/.config/systemd/user/wand.service" ]; then SERVICE_EXISTS=1; fi
fi
if [ -d "$NPM_ROOT_CHECK/@co0ontty/wand" ] || [ -f "$CONFIG_PATH" ] || [ -f "$(dirname "$CONFIG_PATH")/wand.db" ] || [ -f "$(dirname "$CONFIG_PATH")/wand.pid" ] || [ "$SERVICE_EXISTS" = 1 ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$SCRIPT_DIR/scripts/recover-web-update.sh" ]; then
    bash "$SCRIPT_DIR/scripts/recover-web-update.sh"
  else
    ensure_install_temp
    RECOVERY_SCRIPT="$INSTALL_TEMP_DIR/recover-web-update.sh"
    curl -fLsS https://raw.githubusercontent.com/co0ontty/wand/master/scripts/recover-web-update.sh -o "$RECOVERY_SCRIPT"
    bash "$RECOVERY_SCRIPT"
  fi
  exit $?
fi

# --- Install wand ---
INSTALL_CHANNEL="${WAND_UPDATE_CHANNEL:-stable}"
case "$INSTALL_CHANNEL" in stable|beta) ;; *) error "WAND_UPDATE_CHANNEL must be stable or beta" ;; esac
if [ -f "$SCRIPT_DIR/scripts/update-target.js" ]; then
  TARGET_SELECTOR="$SCRIPT_DIR/scripts/update-target.js"
else
  ensure_install_temp
  TARGET_SELECTOR="$INSTALL_TEMP_DIR/update-target.js"
  curl -fLsS https://raw.githubusercontent.com/co0ontty/wand/master/scripts/update-target.js -o "$TARGET_SELECTOR"
fi
INSTALL_TAGS="$(npm view @co0ontty/wand dist-tags --json)"
INSTALL_VERSION="$(node "$TARGET_SELECTOR" "$INSTALL_CHANNEL" "$INSTALL_TAGS")"
ENGINE_RANGE="$(npm view "@co0ontty/wand@$INSTALL_VERSION" engines.node)"
if [[ "$ENGINE_RANGE" =~ ^\>=([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  wand_ensure_update_node "${BASH_REMATCH[1]}" || error "目标版本要求 Node.js $ENGINE_RANGE；当前安装未修改。"
fi
if [ -f "$SCRIPT_DIR/scripts/recover-web-update.mjs" ]; then PREFIX_SELECTOR="$SCRIPT_DIR/scripts/recover-web-update.mjs";
else
  ensure_install_temp
  PREFIX_SELECTOR="$INSTALL_TEMP_DIR/recover-web-update.mjs"
  curl -fLsS https://raw.githubusercontent.com/co0ontty/wand/master/scripts/recover-web-update.mjs -o "$PREFIX_SELECTOR"
fi
INSTALL_PREFIX="$(node "$PREFIX_SELECTOR" prefix "${WAND_INSTALL_PREFIX:-$(npm prefix -g)}" "$HOME")"
info "Installing @co0ontty/wand@$INSTALL_VERSION..."
npm install -g --engine-strict --prefix "$INSTALL_PREFIX" "@co0ontty/wand@$INSTALL_VERSION" || error "npm install failed."
NODE_BIN="$(command -v node)"
GLOBAL_WAND_BIN="$INSTALL_PREFIX/bin/wand"
export PATH="$INSTALL_PREFIX/bin:$PATH"
[ -f "$GLOBAL_WAND_BIN" ] || error "安装后全局 wand 入口缺失。"
printf -v CONFIG_ARGUMENT '%q' "$CONFIG_PATH"

# --- Init (needed before service:install reads config) ---
info "Initializing wand..."
"$NODE_BIN" "$GLOBAL_WAND_BIN" init -c "$CONFIG_PATH"
"$NODE_BIN" --input-type=module - "$GLOBAL_WAND_BIN" "$CONFIG_PATH" "$INSTALL_CHANNEL" <<'NODE'
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [bin, configPath, channel] = process.argv.slice(2);
const packageDir = path.dirname(path.dirname(realpathSync(bin)));
const { WandStorage, resolveDatabasePath } = await import(pathToFileURL(path.join(packageDir, "dist/storage.js")).href);
const storage = new WandStorage(resolveDatabasePath(configPath));
try { storage.setConfigValue("updateChannel", channel); } finally { storage.close(); }
NODE
if WAND_INITIAL_PASSWORD="$(read_wand_password "$CONFIG_PATH")"; then
  info "Wand login password: ${GREEN}${WAND_INITIAL_PASSWORD}${NC}"
  info "You can view it again with: ${GREEN}wand config:password -c ${CONFIG_ARGUMENT}${NC}"
else
  warn "Unable to read Wand login password. Try: wand config:password"
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

MODE=$(choose_install_mode)

case "$MODE" in
  service)
    # 系统级。Root 直接装;非 root 走 sudo（首次会让用户输密码）
    info "Installing wand as a system-wide systemd / launchd service..."
    if [ -n "$SUDO" ]; then
      info "需要 sudo 密码以写入 /etc/systemd/system/:"
    fi
    if $SUDO "$NODE_BIN" "$GLOBAL_WAND_BIN" service:install -c "$CONFIG_PATH"; then
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
    if "$NODE_BIN" "$GLOBAL_WAND_BIN" service:install --user -c "$CONFIG_PATH"; then
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
