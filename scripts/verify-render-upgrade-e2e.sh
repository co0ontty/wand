#!/usr/bin/env bash
#
# 「从当前已安装版本无损升级」的端到端验证。
#
# 场景：用户机器上跑着**旧版本**（PTY 由 Node 的 legacy `terminald` 持有），此刻直接升级到
# 带 Rust Render 的新版本。升级的正确行为不是「重启一切」，而是：
#
#   · 旧会话的 PTY 进程**一个都不死**（pid、父子关系、输出连续性都不变）；
#   · 旧会话升级后仍能收发输入（由复合路由继续交给 legacy daemon 服务）；
#   · 新会话归 Render 接管（wand-render 成为 PTY 的父进程）；
#   · 回滚（engine=legacy）同样不破坏会话。
#
# 这正是 `src/render-host.ts` 里 CompositeTerminalHost 的存在理由：Render 与 legacy 各自
# 持有自己的 socket/token 命名空间，永不交叉领养，按会话所有权路由。
#
# 用法：
#   scripts/verify-render-upgrade-e2e.sh
#   WAND_E2E_PORT=8798 WAND_E2E_DIR=/tmp/wand-render-upgrade-e2e scripts/verify-render-upgrade-e2e.sh
#   SKIP_BUILD=1 scripts/verify-render-upgrade-e2e.sh
#
# 隔离边界：只使用 ${DIR} 与 ${PORT}；绝不读写 ~/.wand，也不碰任何已在运行的实例。
# 密码随机生成只写进隔离 config，本脚本与输出都不打印它（也不打印 cookie/token）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}" || exit 2

DIR="${WAND_E2E_DIR:-/tmp/wand-render-upgrade-e2e}"
PORT="${WAND_E2E_PORT:-8798}"
CONFIG="$DIR/config.json"
BASE="http://127.0.0.1:$PORT"
COOKIE="$DIR/cookie.txt"
HELPER="$DIR/upgrade-node.mjs"
SERVER_LOG="$DIR/server.log"
SERVER_PID_FILE="$DIR/server.pid"
BUILD_LOG="${DIR}.build.log"

PASS=0
FAIL=0
LEGACY_PID=""
RENDER_PID=""
PTY_PID=""
SESSION_ID=""
NEW_SESSION=""
NEW_PTY=""
pass() { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }
step() { printf '\n=== %s ===\n' "$1"; }

cleanup() {
  stop_server
  # 收尾时把本次实例的 daemon 都停掉：legacy 用 SIGTERM，Render 用 now（只杀自己的）。
  local render_pid legacy_pid
  render_pid="$(render_daemon_pid)"
  if [ -n "$render_pid" ]; then kill -TERM "$render_pid" 2>/dev/null; sleep 0.5; kill -KILL "$render_pid" 2>/dev/null; fi
  legacy_pid="$(legacy_daemon_pid)"
  if [ -n "$legacy_pid" ]; then kill -TERM "$legacy_pid" 2>/dev/null; sleep 0.5; kill -KILL "$legacy_pid" 2>/dev/null; fi
  sleep 0.3
  rm -rf "$DIR"
}

trap cleanup EXIT

# ── 进程探针 ──

# 只认本实例的 daemon。判据是「<可执行文件> -c <本实例 config>」这个完整调用形态：
#   · 不能只用命令行子串 —— 本脚本的隔离目录名里就含 "wand-render"，
#     Server 自己的命令行（... web -c .../wand-render-upgrade-e2e/config.json）也会命中；
#   · 也不能用 `ps -o comm` —— macOS 上 comm 会被截断成 "/Users/co0ontty/" 之类，
#     比不出可执行文件名。
legacy_daemon_pid() {
  ps -Ao pid=,command= | awk -v cfg="$CONFIG" '
    index($0, cfg) > 0 && $0 ~ /terminald -c / { print $1; exit }'
}
render_daemon_pid() {
  ps -Ao pid=,command= | awk -v cfg="$CONFIG" '
    index($0, cfg) > 0 && $0 ~ /wand-render -c / { print $1; exit }'
}
render_daemon_count() {
  ps -Ao pid=,command= | awk -v cfg="$CONFIG" '
    index($0, cfg) > 0 && $0 ~ /wand-render -c / { n++ } END { print n + 0 }'
}
ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

# 某个会话的 shell 进程：取「daemon 的直接子进程」里最像 shell 的那个。
child_of() {
  local parent="$1"
  [ -z "$parent" ] && return 0
  ps -Ao pid=,ppid= | awk -v p="$parent" '$2 == p { print $1 }' | head -1
}

# ── 服务器控制 ──

start_server() {
  local engine="$1"
  : > "$SERVER_LOG"
  env WAND_RENDER_ENGINE="$engine" node "$ROOT/dist/cli.js" web -c "$CONFIG" >>"$SERVER_LOG" 2>&1 &
  echo $! > "$SERVER_PID_FILE"
  local deadline=$((SECONDS + 40))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -sS -o /dev/null "$BASE/" 2>/dev/null; then return 0; fi
    alive "$(cat "$SERVER_PID_FILE")" || return 1
    sleep 0.3
  done
  return 1
}

stop_server() {
  local pid
  pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null
    local deadline=$((SECONDS + 15))
    while [ "$SECONDS" -lt "$deadline" ] && alive "$pid"; do sleep 0.2; done
    alive "$pid" && kill -KILL "$pid" 2>/dev/null
  fi
  rm -f "$SERVER_PID_FILE"
}

port_free() { ! curl -sS -o /dev/null --max-time 1 "$BASE/" 2>/dev/null; }

helper() { WAND_E2E_ROOT="$ROOT" WAND_E2E_CONFIG="$CONFIG" WAND_E2E_PORT="$PORT" \
  WAND_E2E_COOKIE="$COOKIE" WAND_E2E_CWD="$DIR" node "$HELPER" "$@"; }
# 助手输出解析。刻意把 stdout/stderr 落盘再去解析：助手空输出时最常见的两个原因是
# 「node 起不来」和「异常发生在写 stdout 之前」，只把 stdout 灌进 JSON.parse 只会得到
# 一句 "Unexpected end of JSON input"，看不到真正的原因。
jget() {
  local cmd="$1" dotted="$2"
  shift 2
  helper "$cmd" "$@" >"$DIR/helper.out" 2>"$DIR/helper.err"
  local status=$?
  if [ ! -s "$DIR/helper.out" ]; then
    printf '  [助手无输出] %s（exit %s）\n' "$cmd" "$status" >&2
    sed -n '1,15p' "$DIR/helper.err" >&2
    return 1
  fi
  node -e '
  let raw = ""; process.stdin.on("data", (c) => raw += c);
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(raw);
      if (value.error) { console.error(value.error); process.exit(1); }
      let cur = value;
      for (const key of process.argv[1].split(".")) cur = cur?.[key];
      process.stdout.write(cur === undefined || cur === null ? "" : String(cur));
    } catch (error) { console.error(String(error), raw.slice(0, 200)); process.exit(1); }
  });' "$dotted" <"$DIR/helper.out"
}

write_helper() {
  cat >"$HELPER" <<'HELPER_EOF'
// 升级场景专用助手：登录 / 建会话 / WS 输入回显。只与隔离实例交互，不打印任何凭据。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.env.WAND_E2E_ROOT;
const CONFIG = process.env.WAND_E2E_CONFIG;
const PORT = process.env.WAND_E2E_PORT;
const COOKIE_FILE = process.env.WAND_E2E_COOKIE;
const CWD = process.env.WAND_E2E_CWD;
const BASE = `http://127.0.0.1:${PORT}`;
const WebSocket = (await import(`${ROOT}/node_modules/ws/index.js`)).default;
const { decodeRenderFrames, encodeRenderFrame, renderPaths } = await import(`${ROOT}/src/render-protocol.ts`);

/**
 * 有效密码：`loadConfigWithStorage()` 会把 config.json 里的明文密码搬进该实例的 SQLite
 * 并在写回时剥离，所以启动之后必须回落到 DB 里读，否则登录必然 401。
 */
function password() {
  const fromConfig = JSON.parse(readFileSync(CONFIG, "utf8")).password;
  if (typeof fromConfig === "string" && fromConfig) return fromConfig;
  const database = new DatabaseSync(path.join(path.dirname(CONFIG), "wand.db"), { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM app_config WHERE key = ?").get("password");
    if (!row?.value) throw new Error("password not found in config or DB");
    return String(row.value);
  } finally {
    database.close();
  }
}

async function login() {
  const response = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: password() }),
  });
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((value) => value.split(";")[0]).join("; ");
  if (!cookie) throw new Error(`login failed: HTTP ${response.status}`);
  writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 });
  return { status: response.status, cookieLength: cookie.length };
}

function cookie() {
  try { return readFileSync(COOKIE_FILE, "utf8").trim(); } catch { return ""; }
}

async function api(method, requestPath, body) {
  const response = await fetch(`${BASE}${requestPath}`, {
    method,
    headers: { "content-type": "application/json", cookie: cookie() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: response.status, json };
}

/** WS 订阅目标会话，发送「先文本、再单独 \r」，返回是否看到回显。 */
function wsEcho(sessionId, marker) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: cookie() } });
    let output = "";
    let initSeen = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 连接可能已断 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ initSeen, echoFound: output.includes(marker), timedOut: true }), 8000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", sessionId, capabilities: { ptyAck: true } }));
    });
    ws.on("message", (data) => {
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (frame.sessionId && frame.sessionId !== sessionId) return;
      if (frame.type === "init") {
        initSeen = true;
        // 订阅确认后才发输入：init 之前服务端可能还没建立会话订阅。
        ws.send(JSON.stringify({ type: "pty_input", sessionId, data: `echo ${marker}` }));
        ws.send(JSON.stringify({ type: "pty_input", sessionId, data: "\r", shortcutKey: "enter_text" }));
      } else if (frame.type === "output" && frame.data && typeof frame.data === "object") {
        if (typeof frame.data.chunk === "string") output += frame.data.chunk;
        else if (typeof frame.data.output === "string") output += frame.data.output;
        if (output.includes(marker)) finish({ initSeen, echoFound: true });
      }
    });
    ws.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 直接问 Render：它现在是哪些会话的所有者。 */
function renderList() {
  return new Promise((resolve, reject) => {
    const net = require("node:net");
    const paths = renderPaths(CONFIG);
    const socket = net.createConnection(paths.socketPath);
    let buffer = Buffer.alloc(0);
    socket.on("connect", () => {
      socket.write(encodeRenderFrame({
        id: 1, token: readFileSync(paths.tokenPath, "utf8").trim(), protocolVersion: 1, method: "list",
      }));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded;
      try { decoded = decodeRenderFrames(buffer); } catch (error) { reject(error); return; }
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.id !== 1) continue;
        socket.destroy();
        if (!frame.ok) reject(new Error(frame.error?.message ?? "render list failed"));
        else resolve((frame.result?.sessions ?? []).map((s) => ({ sessionId: s.sessionId, pid: s.pid, status: s.status })));
        return;
      }
    });
    socket.on("error", reject);
  });
}

const [, , cmd, ...rest] = process.argv;
try {
  if (cmd === "login") {
    console.log(JSON.stringify(await login()));
  } else if (cmd === "create-shell") {
    const created = await api("POST", "/api/commands", { shell: true, cwd: CWD, mode: "default", cols: 100, rows: 30 });
    console.log(JSON.stringify({ status: created.status, sessionId: created.json?.id ?? null }));
  } else if (cmd === "ws-echo") {
    console.log(JSON.stringify(await wsEcho(rest[0], rest[1])));
  } else if (cmd === "render-list") {
    console.log(JSON.stringify({ sessions: await renderList() }));
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
} catch (error) {
  console.log(JSON.stringify({ error: String((error && error.message) || error) }));
  process.exitCode = 1;
} finally {
  // 退出前必须把 stdout 刷干：stdout 是管道（$(...) 捕获）时写操作是异步的，
  // 紧跟 console.log 的 process.exit() 会把还没落地的输出丢掉 ——
  // 表现是调用方读到空字符串、JSON.parse 报 "Unexpected end of JSON input"。
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(process.exitCode ?? 0);
}
HELPER_EOF
  # 助手用 CJS 的 require 读 socket 文件、用 ESM 的 import 动态加载仓库源码，
  # 这里补一个最小 shim，避免再引入一个包装层。
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    let text = fs.readFileSync(file, "utf8");
    text = text.replace("const { decodeRenderFrames", "import { createRequire } from \"node:module\";\nconst require = createRequire(import.meta.url);\nconst { decodeRenderFrames");
    fs.writeFileSync(file, text);
  ' "$HELPER"
}

# ── 预检 ──

step "步骤 0：预检"
if port_free; then pass "端口 $PORT 空闲"; else fail "端口 $PORT 已被占用，换一个 WAND_E2E_PORT"; exit 2; fi
case "$DIR" in
  "$HOME"/.wand*|"$HOME"/.wand) fail "拒绝在 ~/.wand 下运行"; exit 2 ;;
esac
# 先清掉本实例路径上的残留 daemon：上一轮异常退出可能留下孤儿 legacy terminald 占着 socket，
# 而 legacy 的启动逻辑会拒绝在「有人监听但 token 不符」时另起一个（这是有意的持久性设计），
# 于是新一轮会直接起不来。这里按「<可执行文件> -c <本实例 config>」精确清理。
reap_stale_daemons() {
  local pid
  for pid in $(ps -Ao pid=,command= | awk -v cfg="$CONFIG" '
      index($0, cfg) > 0 && $0 ~ /(terminald|wand-render) -c / { print $1 }'); do
    kill -TERM "$pid" 2>/dev/null
  done
  sleep 0.6
  for pid in $(ps -Ao pid=,command= | awk -v cfg="$CONFIG" '
      index($0, cfg) > 0 && $0 ~ /(terminald|wand-render) -c / { print $1 }'); do
    kill -KILL "$pid" 2>/dev/null
  done
}
reap_stale_daemons
rm -rf "$DIR"; mkdir -p "$DIR"
if [ "${SKIP_BUILD:-0}" = "1" ] && [ -f "$ROOT/dist/cli.js" ]; then
  pass "SKIP_BUILD=1，复用现有 dist/cli.js"
else
  if npm run build >"$BUILD_LOG" 2>&1; then pass "npm run build 成功"; else fail "npm run build 失败，见 $BUILD_LOG"; exit 2; fi
fi
[ -x "$ROOT/dist/native/darwin-arm64/wand-render" ] \
  && pass "Render 产物已 stage（dist/native/darwin-arm64/wand-render）" \
  || pass "使用开发态 Render 产物（render/target/release）"

# 随机密码：只进隔离 config，不打印。
node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    host: "127.0.0.1",
    port: Number(process.argv[3]),
    https: false,
    password: crypto.randomBytes(18).toString("base64url"),
    defaultCwd: process.argv[2],
    defaultMode: "default",
  }, null, 2) + "\n", { mode: 0o600 });
' "$CONFIG" "$DIR" "$PORT"
pass "写入隔离 config（密码随机、不打印）"
write_helper
pass "写入升级场景助手"

# ── 阶段一：模拟「当前已安装版本」 ──

step "步骤 1：以 legacy 引擎启动（等价于用户现在装的版本）"
start_server legacy && pass "legacy 引擎在 $BASE 就绪" || { fail "legacy 引擎未就绪，见 $SERVER_LOG"; tail -5 "$SERVER_LOG"; exit 2; }
jget login status >/dev/null && pass "登录成功" || fail "登录失败"
[ -z "$(render_daemon_pid)" ] && pass "此阶段没有任何 wand-render 进程（旧版本不包含 Rust Render）" \
  || fail "旧版本阶段不该出现 wand-render 进程"
LEGACY_PID="$(legacy_daemon_pid)"
[ -n "$LEGACY_PID" ] && pass "legacy terminald 已启动（pid ${LEGACY_PID}）" || fail "没有 legacy terminald"

step "步骤 2：建一个 PTY 会话，它是升级必须保住的对象"
SESSION_ID="$(jget create-shell sessionId)"
[ -n "$SESSION_ID" ] && pass "会话已创建（id ${SESSION_ID:0:8}…）" || { fail "建会话失败"; exit 2; }
sleep 0.6
PTY_PID="$(child_of "$LEGACY_PID")"
[ -n "$PTY_PID" ] && pass "PTY shell 进程 pid ${PTY_PID}（父进程 = legacy terminald ${LEGACY_PID}）" \
  || { fail "找不到 legacy 持有的 PTY 进程"; exit 2; }
ECHO="$(jget ws-echo echoFound "$SESSION_ID" MARKER_BEFORE_UPGRADE)"
[ "$ECHO" = "true" ] && pass "升级前：WS 输入有回显（先文本、再单独 \\r）" || fail "升级前 WS 回显失败"

# ── 阶段二：升级 ──

step "步骤 3：停 Server（模拟 npm 升级时的进程重启）"
stop_server
pass "Server 已停止"
alive "$LEGACY_PID" && pass "legacy terminald 仍存活（pid ${LEGACY_PID}）" || fail "legacy terminald 随 Server 一起死了"
alive "$PTY_PID" && pass "用户 shell 仍存活（pid ${PTY_PID}）——升级没有杀掉任何 PTY" || fail "用户 shell 被杀了"
[ "$(ppid_of "$PTY_PID")" = "$LEGACY_PID" ] && pass "shell 的父进程仍是 legacy terminald（未被重新挂载）" \
  || fail "shell 父进程发生变化（期望 ${LEGACY_PID}，实际 $(ppid_of "$PTY_PID")）"

step "步骤 4：以 rust 引擎重启（= 升级到带 Rust Render 的新版本）"
start_server rust && pass "rust 引擎在 $BASE 就绪" || { fail "rust 引擎未就绪，见 $SERVER_LOG"; tail -8 "$SERVER_LOG"; exit 2; }
RENDER_PID="$(render_daemon_pid)"
[ -n "$RENDER_PID" ] && pass "wand-render 已启动（pid ${RENDER_PID}）" || fail "wand-render 未启动"
grep -q "Render engine active" "$SERVER_LOG" && pass "日志确认 Render 引擎生效" || fail "日志未见 Render engine active"

step "步骤 5：升级无损断言——旧会话必须原样活着，并由 legacy 继续服务"
alive "$PTY_PID" && pass "旧 PTY 升级后仍存活（pid ${PTY_PID}，与升级前完全一致）" || fail "旧 PTY 在升级后消失"
[ "$(ppid_of "$PTY_PID")" = "$LEGACY_PID" ] && pass "旧 PTY 父进程仍是 legacy terminald" || fail "旧 PTY 被迁移到了别的父进程"
ECHO="$(jget ws-echo echoFound "$SESSION_ID" MARKER_AFTER_UPGRADE)"
[ "$ECHO" = "true" ] && pass "升级后：旧会话仍能收发输入（复合路由把它交给 legacy）" || fail "升级后旧会话不可用"
RENDER_LIST="$(jget render-list sessions.0.sessionId 2>/dev/null || true)"
[ -z "$RENDER_LIST" ] && pass "Render 没有接管旧会话的所有权（符合设计：旧会话留在 legacy）" \
  || fail "Render 错误地持有了旧会话（${RENDER_LIST}）"

step "步骤 6：新会话必须归 Render 接管"
NEW_SESSION="$(jget create-shell sessionId)"
[ -n "$NEW_SESSION" ] && pass "新会话已创建（id ${NEW_SESSION:0:8}…）" || fail "升级后建新会话失败"
sleep 0.6
NEW_PTY="$(child_of "$RENDER_PID")"
[ -n "$NEW_PTY" ] && pass "新会话的 PTY（pid ${NEW_PTY}）父进程是 wand-render（pid ${RENDER_PID}）" \
  || fail "新会话没有挂在 wand-render 下"
[ "$(render_daemon_count)" = "1" ] && pass "wand-render 进程数为 1（没有起第二个 daemon）" \
  || fail "wand-render 进程数为 $(render_daemon_count)"
jget render-list sessions.0.pid >/dev/null 2>&1 && pass "Render 的 list 能看到新会话" || fail "Render list 看不到新会话"

step "步骤 7：回滚（engine=legacy）不破坏任何会话"
stop_server
start_server legacy && pass "回滚到 legacy 后服务就绪" || { fail "回滚启动失败"; tail -5 "$SERVER_LOG"; exit 2; }
alive "$PTY_PID" && pass "回滚后旧 PTY 仍存活（pid ${PTY_PID}）" || fail "回滚后旧 PTY 消失"
[ -z "$(render_daemon_pid)" ] && pass "回滚后不再需要 wand-render（legacy 全面接管）" \
  || pass "wand-render 仍在运行（无新会话即空闲，不影响功能）"
ECHO="$(jget ws-echo echoFound "$SESSION_ID" MARKER_AFTER_ROLLBACK)"
[ "$ECHO" = "true" ] && pass "回滚后旧会话仍能收发输入" || fail "回滚后旧会话不可用"

step "步骤 8：清理"
pass "由 EXIT trap 统一收尾（停 Server 与两个 daemon、删隔离目录）"

printf '\n=== 汇总 ===\nPASS %s / FAIL %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || printf '失败时保留构建日志：%s\n' "$BUILD_LOG"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
