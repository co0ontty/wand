#!/usr/bin/env bash
# Sourced by install/recovery. Changes only this process's PATH; never removes an old Node runtime.
wand_node_satisfies() {
  local executable="$1"
  local required="$2"
  "$executable" -e '
    const have = process.versions.node.split(".").map(Number);
    const need = process.argv[1].split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (have[i] > need[i]) process.exit(0);
      if (have[i] < need[i]) process.exit(1);
    }
  ' "$required" >/dev/null 2>&1
}

wand_use_existing_node() {
  local required="$1"
  local current=""
  local candidate=""
  local best=""
  local best_version="0.0.0"
  local version=""
  current="$(command -v node 2>/dev/null || true)"
  if [ -n "$current" ] && wand_node_satisfies "$current" "$required"; then return 0; fi
  # nvm installs and Homebrew's versioned prefixes are user-selected runtimes.
  # Do not run arbitrary executables discovered in the project or rewrite nvm aliases.
  for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node \
    /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node \
    /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] || continue
    wand_node_satisfies "$candidate" "$required" || continue
    version="$("$candidate" -p process.versions.node)"
    if [ -z "$best" ] || ! wand_node_satisfies "$candidate" "$best_version"; then
      best="$candidate"
      best_version="$version"
    fi
  done
  [ -n "$best" ] || return 1
  export PATH="$(dirname "$best"):$PATH"
  printf '[wand] 本次更新使用已有 Node.js %s；旧运行时保留。\n' "$best_version"
}

wand_install_nvm_node() {
  local required="$1"
  local nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  [ -s "$nvm_script" ] || return 1
  # nvm is already configured by the user. Source without choosing a default Node.
  # It is not nounset-clean on all supported versions.
  set +u
  . "$nvm_script" --no-use
  if nvm install --no-progress "$required" && nvm use "$required"; then
    set -u
    return 0
  fi
  set -u
  return 1
}

wand_ensure_update_node() {
  local required="$1"
  wand_use_existing_node "$required" && return 0
  printf '[wand] 需要 Node.js >= %s，尝试现有 nvm 安装。\n' "$required"
  wand_install_nvm_node "$required" || return 1
  wand_node_satisfies "$(command -v node)" "$required"
}
