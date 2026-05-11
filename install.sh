#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

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
if command -v systemctl &>/dev/null; then
  for unit in wand wand.service; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}"; then
      $SUDO systemctl stop "$unit" 2>/dev/null || true
      WAND_SYSTEMD_UNIT="$unit"
    fi
  done
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

# --- Restart systemd unit if we stopped it ---
if [ -n "${WAND_SYSTEMD_UNIT:-}" ]; then
  info "Restarting ${WAND_SYSTEMD_UNIT}..."
  $SUDO systemctl start "$WAND_SYSTEMD_UNIT" 2>/dev/null || warn "Failed to restart ${WAND_SYSTEMD_UNIT}, please start it manually."
fi

# --- Init ---
info "Initializing wand..."
wand init

echo ""
info "Installation complete! Run ${GREEN}wand web${NC} to start."
