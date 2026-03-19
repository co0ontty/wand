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

# --- Install wand ---
info "Installing @co0ontty/wand..."
npm install -g @co0ontty/wand || error "npm install failed."

# --- Init ---
info "Initializing wand..."
wand init

echo ""
info "Installation complete! Run ${GREEN}wand web${NC} to start."
