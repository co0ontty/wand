#!/usr/bin/env bash
# One-time recovery, independent of the old globally installed Wand runtime.
set -euo pipefail
RECOVERY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wand-recovery.XXXXXX")"
trap 'rm -rf "$RECOVERY_DIR"' EXIT
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
copy_or_fetch_script() {
  local name="$1"
  if [ -f "$SCRIPT_DIR/$name" ]; then cp "$SCRIPT_DIR/$name" "$RECOVERY_DIR/$name";
  else curl -fLsS "https://raw.githubusercontent.com/co0ontty/wand/master/scripts/$name" -o "$RECOVERY_DIR/$name"; fi
}
copy_or_fetch_script update-node.sh
copy_or_fetch_script update-target.js
copy_or_fetch_script recover-web-update.mjs
. "$RECOVERY_DIR/update-node.sh"
wand_ensure_update_node "$WAND_MINIMUM_NODE_VERSION" || { echo "需要 Node.js >=$WAND_MINIMUM_NODE_VERSION；旧服务与安装未修改。" >&2; exit 1; }

PLATFORM="$(uname -s)"
SYSTEM=0
USER_SERVICE=0
SERVICE_FILE=""
if [ "$PLATFORM" = "Darwin" ]; then
  [ ! -f /Library/LaunchDaemons/com.wand.web.plist ] || SYSTEM=1
  [ ! -f "$HOME/Library/LaunchAgents/com.wand.web.plist" ] || USER_SERVICE=1
else
  [ ! -f /etc/systemd/system/wand.service ] || SYSTEM=1
  [ ! -f "$HOME/.config/systemd/user/wand.service" ] || USER_SERVICE=1
fi
if [ "$SYSTEM" = 1 ] && [ "$USER_SERVICE" = 1 ]; then
  echo "存在 system/user 两份服务，无法安全判断更新目标；旧安装未修改。" >&2; exit 1
fi
SCOPE="standalone"
if [ "$SYSTEM" = 1 ]; then
  SCOPE="system"
  if [ "$PLATFORM" = "Darwin" ]; then SERVICE_FILE=/Library/LaunchDaemons/com.wand.web.plist;
  else SERVICE_FILE=/etc/systemd/system/wand.service; fi
elif [ "$USER_SERVICE" = 1 ]; then
  SCOPE="user"
  if [ "$PLATFORM" = "Darwin" ]; then SERVICE_FILE="$HOME/Library/LaunchAgents/com.wand.web.plist";
  else SERVICE_FILE="$HOME/.config/systemd/user/wand.service"; fi
fi
CONFIG_PATH="${WAND_CONFIG_PATH:-}"
if [ -z "$CONFIG_PATH" ]; then
  if [ -n "$SERVICE_FILE" ]; then
    CONFIG_PATH="$(node "$RECOVERY_DIR/recover-web-update.mjs" config "$SERVICE_FILE" "$PLATFORM")"
  else CONFIG_PATH="$HOME/.wand/config.json"; fi
fi
CONFIG_PATH="$(node -p 'require("node:path").resolve(process.argv[1])' "$CONFIG_PATH")"
[ -f "$CONFIG_PATH" ] || { echo "未找到原配置，请指定 WAND_CONFIG_PATH；不创建替代配置或覆盖旧数据库。" >&2; exit 1; }

CHANNEL="${WAND_UPDATE_CHANNEL:-}"
if [ -z "$CHANNEL" ]; then
  CHANNEL="$(node --input-type=module - "$CONFIG_PATH" <<'NODE'
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const configPath = process.argv[2];
let channel = JSON.parse(readFileSync(configPath, "utf8")).updateChannel ?? "stable";
const dbPath = path.join(path.dirname(configPath), "wand.db");
if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get("app_config")) {
      channel = db.prepare("SELECT value FROM app_config WHERE key=?").get("updateChannel")?.value ?? channel;
    }
  } finally { db.close(); }
}
console.log(channel === "beta" ? "beta" : "stable");
NODE
)"
fi
case "$CHANNEL" in stable|beta) ;; *) echo "WAND_UPDATE_CHANNEL must be stable or beta" >&2; exit 1 ;; esac
TAGS="$(npm view @co0ontty/wand dist-tags --json)"
VERSION="$(node "$RECOVERY_DIR/update-target.js" "$CHANNEL" "$TAGS")"
ENGINE_RANGE="$(npm view "@co0ontty/wand@$VERSION" engines.node)"
if [[ "$ENGINE_RANGE" =~ ^\>=([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  wand_ensure_update_node "${BASH_REMATCH[1]}" || { echo "目标版本要求 Node.js $ENGINE_RANGE；旧安装未修改。" >&2; exit 1; }
fi
NODE_BIN="$(command -v node)"
INSTALL_PREFIX="$("$NODE_BIN" "$RECOVERY_DIR/recover-web-update.mjs" prefix "${WAND_INSTALL_PREFIX:-$(npm prefix -g)}" "$HOME" "$CONFIG_PATH")"
GLOBAL_ROOT="$INSTALL_PREFIX/lib/node_modules"
GLOBAL_BIN="$INSTALL_PREFIX/bin/wand"
echo "[wand-recovery] preparing $VERSION ($CHANNEL subscription); current service stays online"
npm install -g --engine-strict --prefix "$RECOVERY_DIR/prepared" "@co0ontty/wand@$VERSION"
PREPARED="$RECOVERY_DIR/prepared/lib/node_modules/@co0ontty/wand"
for name in core-status-cli update-health update-legacy deployment-lock; do
  # A checkout may contain an older dist; use the matching source protocol there.
  if [ ! -f "$SCRIPT_DIR/../src/$name.ts" ] && [ -f "$SCRIPT_DIR/../dist/$name.js" ]; then
    cp "$SCRIPT_DIR/../dist/$name.js" "$RECOVERY_DIR/$name.js"
    case "$name" in core-status-cli) GUARD_PATH="$RECOVERY_DIR/$name.js" ;; update-health) HEALTH_PATH="$RECOVERY_DIR/$name.js" ;; update-legacy) LEGACY_PATH="$RECOVERY_DIR/$name.js" ;; esac
  else
    if [ -f "$SCRIPT_DIR/../src/$name.ts" ]; then cp "$SCRIPT_DIR/../src/$name.ts" "$RECOVERY_DIR/$name.ts";
    else curl -fLsS "https://raw.githubusercontent.com/co0ontty/wand/master/src/$name.ts" -o "$RECOVERY_DIR/$name.ts"; fi
    case "$name" in core-status-cli) GUARD_PATH="$RECOVERY_DIR/$name.ts" ;; update-health) HEALTH_PATH="$RECOVERY_DIR/$name.ts" ;; update-legacy) LEGACY_PATH="$RECOVERY_DIR/$name.ts" ;; esac
  fi
done
ALLOW_STOPPED=0
if [ "$SCOPE" = "standalone" ]; then ALLOW_STOPPED=1
elif [ "$PLATFORM" = "Darwin" ]; then
  DOMAIN="system"
  [ "$SCOPE" = "system" ] || DOMAIN="gui/$(id -u)"
  if ! launchctl print "$DOMAIN/com.wand.web" > "$RECOVERY_DIR/service-state.txt" 2>&1; then
    if grep -Eq 'Could not find (specified )?service' "$RECOVERY_DIR/service-state.txt"; then ALLOW_STOPPED=1; fi
  fi
else
  if [ "$SCOPE" = "user" ]; then
    if SERVICE_STATE="$(systemctl --user is-active wand.service 2>/dev/null)"; then :; else
      case "$SERVICE_STATE" in inactive|failed|unknown) ALLOW_STOPPED=1 ;; esac
    fi
  else
    if SERVICE_STATE="$(systemctl is-active wand.service 2>/dev/null)"; then :; else
      case "$SERVICE_STATE" in inactive|failed|unknown) ALLOW_STOPPED=1 ;; esac
    fi
  fi
fi
# No sudo around the transaction: package, DB and WAL stay owned by the caller.
# Only system-service registration prompts for its existing required privilege.
"$NODE_BIN" --input-type=module - "$GUARD_PATH" "$LEGACY_PATH" "$CONFIG_PATH" "$ALLOW_STOPPED" "$GLOBAL_ROOT" "$NODE_BIN" "$RECOVERY_DIR/recover-web-update.mjs" apply "$PREPARED" "$GLOBAL_ROOT" "$GLOBAL_BIN" "$CONFIG_PATH" "$SCOPE" "$PLATFORM" "$HEALTH_PATH" "$GUARD_PATH" <<'NODE'
import { pathToFileURL } from "node:url";
const [guardPath, legacyPath, configPath, stopped, root, ...command] = process.argv.slice(2);
const guard = await import(pathToFileURL(guardPath).href);
const { waitForCompatibleUpdate } = await import(pathToFileURL(legacyPath).href);
const { withRecoveryLock } = await import(pathToFileURL(command[1]).href);
process.exitCode = await withRecoveryLock(root, guardPath,
  () => waitForCompatibleUpdate(configPath, 300, command, stopped === "1", guard));
NODE
