#!/usr/bin/env bash
#
# Render/Server 分离的端到端验证（契约：`render/docs/render-protocol.md`）。
#
# 逐步跑完「stage 产物 → 隔离实例 → 建 PTY → WS 输入 → Server 重启 PTY 不丢 →
# Render 崩溃自愈 → Web/Android profile → drain 保留 PTY → 回滚/dev/stub 路径 → 清理」，
# 每一步都断言并打印真实证据。
#
# 隔离边界（硬要求）：
#   · 只在 ${DIR}（默认 /tmp/wand-render-e2e）下写文件，且只通过 `-c $CONFIG` 使用它；
#     唯一例外是构建日志 ${DIR}.build.log（放在 DIR 外面，失败时能保留下来看原因，
#     成功时在收尾删除）；
#   · 只在 ${PORT}（默认 8791）上监听；
#   · 绝不读/写 ~/.wand，也不碰任何其他正在运行的实例。
#
# 二进制来自新布局（旧 `wand-rs/` 与仓库根 `native/` 已不存在）：
#   1. ${WAND_RENDER_BIN}（显式指定，优先）
#   2. render/ 子模块的 cargo 产物 render/target/{release,debug}/wand-render（开发态）
#   3. dist/native/<triple>/wand-render（`npm run build:render-bin` 从 render-bin 子模块 stage 的发布产物）
# 开发态产物要先用 `npm run build:render-native`（= cargo build --release）或
# 在 Render 源仓库里 `cargo build --release` 生成。
#
# 用法：
#   scripts/verify-render-e2e.sh                        # 全量（含 npm run build）
#   SKIP_BUILD=1 scripts/verify-render-e2e.sh           # dist 已是最新时跳过构建
#   WAND_E2E_PORT=8795 WAND_E2E_DIR=/tmp/wand-render-e2e2 scripts/verify-render-e2e.sh
#   WAND_RENDER_BIN=/path/to/wand-render scripts/verify-render-e2e.sh
#
# 密码只在开始时随机生成并写进隔离 config（随后被 Server 搬进该实例的 SQLite），
# 本脚本与所有输出都不打印它，也不打印 cookie/token（token 只比较 sha256 是否变化）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 固定工作目录：Server 与 E2E 助手都按仓库根解析相对路径。
cd "${ROOT}" || exit 2
DIR="${WAND_E2E_DIR:-/tmp/wand-render-e2e}"
PORT="${WAND_E2E_PORT:-8791}"
CONFIG="$DIR/config.json"
BASE="http://127.0.0.1:$PORT"
NODE_HELPER="$DIR/e2e-node.mjs"
SERVER_PID_FILE="$DIR/server.pid"
SERVER_LOG="$DIR/server.log"
BUILD_LOG="${DIR}.build.log"

PASS_COUNT=0
FAIL_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  [PASS] %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  [FAIL] %s\n' "$1"; }
step() { printf '\n=== %s ===\n' "$1"; }
info() { printf '  · %s\n' "$1"; }

# ── 隔离护栏 ────────────────────────────────────────────────────────────────
case "$DIR" in
  "$HOME/.wand"|"$HOME/.wand"/*) echo "拒绝：DIR 不能指向 ~/.wand（${DIR}）" >&2; exit 2 ;;
  "$HOME"|"$HOME"/*) echo "拒绝：DIR 不能落在 \$HOME 下（${DIR}）——避免碰到用户实例与数据" >&2; exit 2 ;;
esac
case "$CONFIG" in
  "$HOME/.wand"/*) echo "拒绝：config 不能落在 ~/.wand（${CONFIG}）" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || { echo "需要 node" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "需要 curl" >&2; exit 2; }

port_busy() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# 当前平台三元组（与 src/render-binary.ts / render-bin/manifest.json 的键一致）。
platform_triple() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}
TRIPLE="$(platform_triple)"

# 默认二进制：优先开发态 cargo 产物，其次 stage 进 dist 的发布产物。
default_render_bin() {
  local candidate
  for candidate in \
    "$ROOT/render/target/release/wand-render" \
    "$ROOT/render/target/debug/wand-render" \
    "$ROOT/dist/native/$TRIPLE/wand-render"; do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  printf '%s\n' "$ROOT/render/target/release/wand-render"
}
RENDER_BIN="${WAND_RENDER_BIN:-$(default_render_bin)}"

json_field() { node -e '
const [text, path] = process.argv.slice(1);
let value;
try { value = JSON.parse(text); } catch { process.exit(1); }
for (const key of path.split(".")) {
  if (value === null || value === undefined) process.exit(1);
  value = value[key];
}
process.stdout.write(value === undefined || value === null ? "" : String(value));
' "$1" "$2"; }

sha256_of() { node -e 'const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$1"; }

write_node_helper() {
  cat >"$NODE_HELPER" <<'NODE_HELPER_EOF'
// E2E 驱动助手：只与 WAND_E2E_* 指向的隔离实例交互；绝不打印密码/cookie/token。
// 依赖从 WAND_E2E_ROOT 动态 import，避免把仓库绝对路径写进生成文件。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";

const ROOT = process.env.WAND_E2E_ROOT;
const WebSocket = (await import(`${ROOT}/node_modules/ws/index.js`)).default;
const net = (await import("node:net")).default;
const { decodeRenderFrames, encodeRenderFrame, renderPaths } =
  await import(`${ROOT}/dist/render-protocol.js`);

const DIR = process.env.WAND_E2E_DIR;
const PORT = Number(process.env.WAND_E2E_PORT);
const CONFIG = process.env.WAND_E2E_CONFIG || `${DIR}/config.json`;
const COOKIE_FILE = process.env.WAND_E2E_COOKIE || `${DIR}/cookie.txt`;
const CWD = process.env.WAND_E2E_CWD || path.dirname(CONFIG);
const BASE = `http://127.0.0.1:${PORT}`;
// config 可能还没写出来（产物寻址探测在隔离实例之前跑），此时不需要密码。
let cfg = {};
try { cfg = JSON.parse(readFileSync(CONFIG, "utf8")); } catch { /* 未创建 */ }

/**
 * config.json 里的 password 在 Server 启动时被搬进该实例的 SQLite（saveConfig 会剥离
 * 该字段），所以生效密码要从 DB 读。只在本进程内使用，绝不打印。
 */
function effectivePassword() {
  if (typeof cfg.password === "string" && cfg.password) return cfg.password;
  const db = new DatabaseSync(`${path.dirname(CONFIG)}/wand.db`, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get("password");
    if (!row?.value) throw new Error("password not found in config or DB");
    return row.value;
  } finally {
    db.close();
  }
}

const cookie = () => readFileSync(COOKIE_FILE, "utf8").trim();

async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: effectivePassword() }),
  });
  const setCookies = res.headers.getSetCookie();
  const jar = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  if (res.status !== 200 || !jar) throw new Error(`login failed HTTP ${res.status}`);
  writeFileSync(COOKIE_FILE, jar, { mode: 0o600 });
  return { status: res.status, cookieCount: setCookies.length };
}

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, bodyPreview: text.slice(0, 160) };
}

/** Render socket 上的原始 RPC：权威 PTY 状态来源，不经过 Server。 */
function renderRpc(method, params) {
  const { socketPath, tokenPath } = renderPaths(CONFIG);
  const token = readFileSync(tokenPath, "utf8").trim();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    const id = 1;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`render ${method} timeout`)); }, 15_000);
    const finish = (fn, value) => { clearTimeout(timer); try { socket.end(); } catch { /* ignore */ } fn(value); };
    socket.on("connect", () => {
      socket.write(encodeRenderFrame({ id, token, protocolVersion: 1, method, params }));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frames = [];
      try { frames = decodeRenderFrames(buffer).frames; } catch { return; }
      for (const frame of frames) {
        if (frame.id !== id) continue;
        if (frame.ok) finish(resolve, frame.result);
        else finish(reject, new Error(`render ${method} failed: ${JSON.stringify(frame.error)}`));
      }
    });
    socket.on("error", (error) => finish(reject, error));
  });
}

/** 订阅 → 等 init → 发「文本 + 单独 \r（shortcutKey=enter_text）」→ 等 echo。 */
async function wsRoundTrip(sessionId, options) {
  const { withCapabilities = false, payload, waitMs = 8000 } = options;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie() } });
  const frames = [];
  let init = null;
  let outputText = "";
  let ackCount = 0;

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    frames.push(msg);
    if (msg.type === "init" && !init) init = msg;
    // output 帧有两种形态：{data:{incremental,chunk}} 与 {data:{output}}（legacy 全量）。
    if (msg.type === "output" && msg.data && typeof msg.data === "object") {
      if (typeof msg.data.chunk === "string") outputText += msg.data.chunk;
      else if (typeof msg.data.output === "string") outputText += msg.data.output;
    }
    // Android/移动 profile：每帧 output 都要按 ptyBytes 回 ack，否则服务端会降级。
    if (withCapabilities && msg.type === "output" && Number.isFinite(msg.ptyBytes)) {
      ackCount += 1;
      ws.send(JSON.stringify({ type: "pty_ack", sessionId, bytes: msg.ptyBytes }));
    }
  });

  const waitFor = (predicate, label) => new Promise((resolve, reject) => {
    const deadline = Date.now() + waitMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(`timeout waiting for ${label} (frames=${frames.map((f) => f.type).join(",")}; outputTail=${JSON.stringify(outputText.slice(-200))})`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });

  try {
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({
      type: "subscribe",
      sessionId,
      ...(withCapabilities ? { capabilities: { ptyAck: true } } : {}),
    }));
    await waitFor(() => init !== null, "init");
    if (payload) {
      // 项目硬契约：先文本、再单独一个 "\r" 并标 shortcutKey=enter_text。
      // 绝不能用 text + "\n" 代替回车。
      ws.send(JSON.stringify({ type: "pty_input", sessionId, data: payload }));
      ws.send(JSON.stringify({ type: "pty_input", sessionId, data: "\r", shortcutKey: "enter_text" }));
      await waitFor(() => outputText.includes(payload), "echo");
    } else {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }

  const types = frames.map((f) => f.type);
  return {
    initSeen: init !== null,
    initHasTerminalState: !!(init && init.data && init.data.terminalState),
    codeFrames: Array.from(new Set(types)),
    echoFound: payload ? outputText.includes(payload) : null,
    ackCount,
    sawResyncRequired: types.includes("resync_required"),
    sawPtyError: types.includes("pty_error"),
  };
}

const [, , cmd, ...rest] = process.argv;

try {
  if (cmd === "login") {
    console.log(JSON.stringify(await login()));
  } else if (cmd === "create-shell") {
    const created = await api("POST", "/api/commands", {
      shell: true, cwd: CWD, mode: "default", cols: 100, rows: 30,
    });
    const sessionId = created.json?.id ?? null;
    let attached = null;
    try { attached = sessionId ? await renderRpc("attach", { sessionId }) : null; } catch { /* Render 侧可能不可用 */ }
    console.log(JSON.stringify({
      status: created.status,
      sessionId,
      bodyPreview: created.bodyPreview,
      dtoCols: created.json?.ptyCols,
      dtoRows: created.json?.ptyRows,
      renderPid: attached?.state?.pid ?? null,
      incarnationId: attached?.state?.incarnationId ?? null,
      renderStatus: attached?.state?.status ?? null,
    }));
  } else if (cmd === "session-status") {
    const result = await api("GET", `/api/sessions/${encodeURIComponent(rest[0])}`);
    console.log(JSON.stringify({ status: result.status, sessionStatus: result.json?.status ?? null }));
  } else if (cmd === "render-list") {
    const result = await renderRpc("list");
    console.log(JSON.stringify({
      sessions: (result.sessions ?? []).map((s) => ({
        sessionId: s.sessionId, pid: s.pid, status: s.status,
        cols: s.cols, rows: s.rows, seq: s.seq, outputLength: (s.output ?? "").length,
      })),
    }));
  } else if (cmd === "render-paths") {
    const paths = renderPaths(CONFIG);
    console.log(JSON.stringify({
      socketPath: paths.socketPath, pidPath: paths.pidPath,
      tokenPath: paths.tokenPath, metaPath: paths.metaPath,
    }));
  } else if (cmd === "render-stats") {
    console.log(JSON.stringify(await renderRpc("stats")));
  } else if (cmd === "render-shutdown") {
    const mode = rest[0] === "now" ? "now" : "drain";
    console.log(JSON.stringify(await renderRpc("shutdown", { mode })));
  } else if (cmd === "binary-address-probe") {
    // 用给定二进制起一个 daemon，看它把 token/pid 写在不是 Node renderPaths 推导的位置上吗。
    // 判据：Node（realpath 归一化）算出的 tokenPath 必须出现；否则两侧寻址分叉
    // （manifest 里 pin 的产物比 Node 旧时就会这样，Server 会永久等不到 socket）。
    const [binary, probeDir] = rest;
    mkdirSync(probeDir, { recursive: true });
    const probeConfig = path.join(probeDir, "config.json");
    writeFileSync(probeConfig, JSON.stringify({ host: "127.0.0.1", port: 0 }));
    const paths = renderPaths(probeConfig);
    const child = spawn(binary, ["-c", probeConfig], { detached: true, stdio: "ignore" });
    child.unref();
    let tokenSeen = false;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      if (existsSync(paths.tokenPath)) { tokenSeen = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 收尾：杀掉这次起的 daemon，并清掉它用自己的 suffix 绑的 socket 文件。
    const daemonPids = [];
    const suffixList = [];
    for (const name of readdirSync(probeDir)) {
      const match = /^\.render-([0-9a-f]+)\.pid$/.exec(name);
      if (!match) continue;
      suffixList.push(match[1]);
      try {
        const pid = Number(readFileSync(path.join(probeDir, name), "utf8").trim());
        if (pid > 0) { process.kill(pid, "SIGKILL"); daemonPids.push(pid); }
      } catch { /* 已退出 */ }
    }
    for (const file of [paths.socketPath, ...suffixList.map((suffix) => `/tmp/wand-render-${process.getuid()}-${suffix}.sock`)]) {
      try { rmSync(file, { force: true }); } catch { /* best-effort */ }
    }
    console.log(JSON.stringify({
      ok: tokenSeen,
      expectedTokenPath: paths.tokenPath,
      expectedSuffix: path.basename(paths.tokenPath),
      actualArtifacts: readdirSync(probeDir).filter((name) => name.startsWith(".render-")),
      daemonPids,
      socketPath: paths.socketPath,
    }));
  } else if (cmd === "ws") {
    const [sessionId, profile, payload] = rest;
    console.log(JSON.stringify(await wsRoundTrip(sessionId, { withCapabilities: profile === "android", payload })));
  } else if (cmd === "embed") {
    const res = await fetch(`${BASE}/?embed=terminal&nativeInput=1`, { headers: { Cookie: cookie() } });
    const text = await res.text();
    console.log(JSON.stringify({
      status: res.status,
      contentType: res.headers.get("content-type"),
      isHtml: /<html/i.test(text),
      length: text.length,
    }));
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
NODE_HELPER_EOF
}

# 主实例（默认）与子实例（步骤 11 的回滚/dev/stub 路径）共用一套 helper 调用入口。
run_helper_at() {
  local config="$1" cookie="$2" cwd="$3"
  shift 3
  WAND_E2E_CONFIG="$config" WAND_E2E_COOKIE="$cookie" WAND_E2E_CWD="$cwd" \
  WAND_E2E_DIR="$DIR" WAND_E2E_PORT="$PORT" WAND_E2E_ROOT="$ROOT" \
    node "$NODE_HELPER" "$@"
}
run_helper() { run_helper_at "$CONFIG" "$DIR/cookie.txt" "$DIR" "$@"; }

# start_server <config> <log> <pidfile> <engine> [binary]
# 不要在子 shell 里后台启动：那样 `$!` 拿到的是中间 shell，kill 它会留下真正的
# node 进程继续占着端口（「重启」步骤就会静默地测到旧进程）。
start_server() {
  local config="$1" log="$2" pidfile="$3" engine="$4" binary="${5:-}"
  if [ -n "$binary" ]; then
    env WAND_RENDER_ENGINE="$engine" WAND_RENDER_BIN="$binary" \
      node "$ROOT/dist/cli.js" web -c "$config" >>"$log" 2>&1 &
  else
    # 显式 -u：这一路测的就是「没有 WAND_RENDER_BIN 时的自动发现」，
    # 不能把调用者环境里的同名变量漏进来。
    env -u WAND_RENDER_BIN WAND_RENDER_ENGINE="$engine" \
      node "$ROOT/dist/cli.js" web -c "$config" >>"$log" 2>&1 &
  fi
  echo $! >"$pidfile"
}

wait_for_http() {
  local tries="${1:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -sf -o /dev/null "$BASE/" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

# 等端口真的空出来。子实例都用同一个 ${PORT}，上一个没退干净就直接报错，
# 否则后面的断言会静默地打在旧实例上（假 PASS）。
wait_for_port_free() {
  for _ in $(seq 1 60); do
    port_busy || return 0
    sleep 0.5
  done
  return 1
}

# 等进程退出，最多 N 秒；退出返回 0，还活着返回 1。
wait_for_exit() {
  local pid="$1" seconds="$2" ticks=$(( $2 * 2 ))
  for _ in $(seq 1 "$ticks"); do
    ps -p "$pid" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  return 1
}

stop_server() {
  local pidfile="$1"
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  wait_for_exit "$pid" 30
}

process_alive() { ps -p "$1" >/dev/null 2>&1; }

render_pid() { cat "$DIR"/.render-*.pid 2>/dev/null | head -1; }
# daemon 的 ps 行就是「<二进制路径> -c <config>」——用行尾锚定 config 路径，
# 否则调用者自己的 shell 命令行里只要同时出现 "wand-render" 和 "$DIR" 就会被误数。
render_process_count() {
  ps -ax -o command= 2>/dev/null | grep -cE "[w]and-render -c ${CONFIG}$" || true
}
# 本次隔离目录下（含 probe-*）的 Render 进程数。
isolated_render_count() {
  ps -ax -o command= 2>/dev/null | grep -cE "[w]and-render -c ${DIR}[^ ]*config\.json$" || true
}

# ── 预检 ────────────────────────────────────────────────────────────────────
step "步骤 0：预检（端口 / 隔离目录 / 二进制）"
if port_busy; then
  fail "端口 $PORT 已被占用（不碰别人的实例）。用 WAND_E2E_PORT=<空闲端口> 重跑。"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/    /'
  exit 1
fi
pass "端口 $PORT 空闲"
if [ ! -x "$RENDER_BIN" ]; then
  fail "找不到可执行的 wand-render：${RENDER_BIN}"
  info "先跑 npm run build:render-native（cargo build --release），或用 WAND_RENDER_BIN 指定产物"
  exit 1
fi
RENDER_BIN_SHA="$(sha256_of "$RENDER_BIN")"
RENDER_BIN_VERSION="$("$RENDER_BIN" --version 2>&1 | head -1)"
info "wand-render = ${RENDER_BIN}"
info "version = ${RENDER_BIN_VERSION}，sha256 = ${RENDER_BIN_SHA:0:16}…（平台三元组 ${TRIPLE}）"
if printf '%s' "$RENDER_BIN_VERSION" | grep -q '(protocol 1)'; then
  pass "--version 报告 protocol 1"
else
  fail "--version 里没有 '(protocol 1)'：${RENDER_BIN_VERSION}"
fi

# ── 步骤 1：stage render-bin → dist/native ─────────────────────────────────
step "步骤 1：scripts/stage-render-binaries.js（--check / --dry-run / 真实 stage）"
STAGE_CHECK="$(node scripts/stage-render-binaries.js --check 2>&1)"; STAGE_CHECK_EXIT=$?
printf '%s\n' "$STAGE_CHECK" | sed 's/^/    /'
if [ "$STAGE_CHECK_EXIT" -eq 0 ]; then pass "--check 通过（render-bin 的 sha256 校验）"; else fail "--check 失败（exit ${STAGE_CHECK_EXIT}）"; fi
STAGE_DRY="$(node scripts/stage-render-binaries.js --dry-run 2>&1)"; STAGE_DRY_EXIT=$?
if [ "$STAGE_DRY_EXIT" -eq 0 ]; then pass "--dry-run 通过（不写磁盘，全部校验做完）"; else fail "--dry-run 失败（exit ${STAGE_DRY_EXIT}）"; printf '%s\n' "$STAGE_DRY" | sed 's/^/    /'; fi
STAGE_REAL="$(node scripts/stage-render-binaries.js 2>&1)"; STAGE_REAL_EXIT=$?
if [ "$STAGE_REAL_EXIT" -eq 0 ]; then pass "真实 stage 通过"; else fail "真实 stage 失败（exit ${STAGE_REAL_EXIT}）"; printf '%s\n' "$STAGE_REAL" | sed 's/^/    /'; fi

MANIFEST_LATEST="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("render-bin/manifest.json","utf8")).latest)')"
SOURCE_ARTIFACT="$ROOT/render-bin/v${MANIFEST_LATEST}/${TRIPLE}/wand-render"
DIST_ARTIFACT="$ROOT/dist/native/${TRIPLE}/wand-render"
info "manifest latest = v${MANIFEST_LATEST}，本平台产物 = ${SOURCE_ARTIFACT#${ROOT}/}"
if [ -x "$DIST_ARTIFACT" ]; then
  SOURCE_SHA="$(sha256_of "$SOURCE_ARTIFACT")"
  DIST_SHA="$(sha256_of "$DIST_ARTIFACT")"
  info "render-bin sha256 = ${SOURCE_SHA:0:16}… / dist/native sha256 = ${DIST_SHA:0:16}…"
  if [ "$SOURCE_SHA" = "$DIST_SHA" ]; then
    pass "dist/native 与 render-bin 的产物 sha256 完全一致"
  else
    fail "sha256 不一致：${SOURCE_SHA} != ${DIST_SHA}"
  fi
  DIST_VERSION_OUT="$("$DIST_ARTIFACT" --version 2>&1 | head -1)"
  info "dist/native 二进制 --version = ${DIST_VERSION_OUT}"
  if printf '%s' "$DIST_VERSION_OUT" | grep -qi stub; then
    fail "dist/native 是 stub（--version 输出含 stub）"
  elif printf '%s' "$DIST_VERSION_OUT" | grep -q '(protocol 1)'; then
    pass "dist/native 不是 stub，且报告 protocol 1"
  else
    fail "dist/native --version 输出不可用：${DIST_VERSION_OUT}"
  fi
else
  fail "stage 之后 dist/native 里没有 ${DIST_ARTIFACT}"
fi

# ── 步骤 2/3：构建 + 隔离实例 ──────────────────────────────────────────────
step "步骤 2：npm run build"
if [ "${SKIP_BUILD:-0}" = "1" ] && [ -f "$ROOT/dist/cli.js" ]; then
  info "SKIP_BUILD=1，复用现有 dist/cli.js"
  pass "dist/cli.js 存在"
else
  if ( cd "$ROOT" && npm run build >"$BUILD_LOG" 2>&1 ); then
    pass "npm run build 成功（日志 ${BUILD_LOG}）"
  else
    fail "npm run build 失败，见 $BUILD_LOG"
    tail -20 "$BUILD_LOG" | sed 's/^/    /'
    exit 1
  fi
fi
if [ -f "$ROOT/dist/cli.js" ] && [ -x "$DIST_ARTIFACT" ]; then
  pass "dist/cli.js 与 dist/native/${TRIPLE}/wand-render 均已就位"
else
  fail "dist 产物不完整（cli.js=${ROOT}/dist/cli.js，native=${DIST_ARTIFACT}）"
fi

step "步骤 3：隔离实例（${DIR}）"
rm -rf "$DIR"
mkdir -p "$DIR"
chmod 700 "$DIR"
# 随机密码只写进隔离 config；Server 启动后会把它搬进该实例的 SQLite。
node -e '
const fs = require("fs");
const crypto = require("crypto");
const [configPath, port] = process.argv.slice(1);
fs.writeFileSync(configPath, JSON.stringify({
  host: "127.0.0.1",
  port: Number(port),
  https: false,
  password: crypto.randomBytes(16).toString("hex"),
  defaultCwd: require("path").dirname(configPath),
  defaultMode: "default",
}, null, 2));
' "$CONFIG" "$PORT"
chmod 600 "$CONFIG"
pass "写入隔离 config（密码随机、不打印）"

write_node_helper
pass "写入 E2E 助手 $NODE_HELPER"

# ── 步骤 3b：产物寻址一致性 ───────────────────────────────────────────────
step "步骤 3b：产物寻址一致性（Node 的 realpath 归一化 vs 二进制自身派生）"
# 这一条专门抓「产物的路径派生与 Node 不一致」这类问题（render-bin 里 pin 的产物比 Node 旧、
# 子模块提交状态缺 §9.2 归一化）：不一致时 Server 会永久等不到 socket/token
# （engine=rust 直接起不来）。非致命，继续后续步骤。
DEV_BINARY_EXPECTED="$ROOT/render/target/release/wand-render"
DEV_BINARY_ADOPTABLE="no"
for ENTRY in \
  "当前 RENDER_BIN|${RENDER_BIN}|RENDERBIN" \
  "dist/native 发布产物|${DIST_ARTIFACT}|distnative" \
  "开发态 cargo 产物|${DEV_BINARY_EXPECTED}|rendertarget"; do
  LABEL="${ENTRY%%|*}"; REST="${ENTRY#*|}"; BINARY="${REST%%|*}"; KEY="${REST##*|}"
  if [ ! -x "$BINARY" ]; then info "${LABEL} 不存在（${BINARY#${ROOT}/}），跳过寻址探测"; continue; fi
  PROBE_DIR="$DIR/address-probe-$KEY"
  PROBE="$(run_helper binary-address-probe "$BINARY" "$PROBE_DIR")"
  if [ "$(json_field "$PROBE" ok)" = "true" ]; then
    pass "${LABEL} 的寻址与 Node 一致（token 落在 $(json_field "$PROBE" expectedSuffix)）"
    [ "$KEY" = "rendertarget" ] && DEV_BINARY_ADOPTABLE="yes"
  else
    fail "${LABEL} 的寻址与 Node 分叉：Node 期望 $(json_field "$PROBE" expectedSuffix)，Daemon 实际写出 $(json_field "$PROBE" actualArtifacts)"
    info "该产物是旧实现（只做词法归一，不解析 /tmp → /private/tmp 这类符号链接）：需要从当前 Render 源码重新构建并发布"
  fi
  rm -rf "$PROBE_DIR"
done
if [ "$DEV_BINARY_ADOPTABLE" = "yes" ]; then info "开发态产物可用，步骤 11b 会做完整运行时验证"; else info "开发态产物不可用或缺失，步骤 11b 只做路径解析验证"; fi

# ── 步骤 4：启动 Server + Render ──────────────────────────────────────────
step "步骤 4：启动 Server（engine=rust，WAND_RENDER_BIN=${RENDER_BIN}）"
: >"$SERVER_LOG"
start_server "$CONFIG" "$SERVER_LOG" "$SERVER_PID_FILE" rust "$RENDER_BIN"
if wait_for_http 80; then pass "Server 在 $BASE 就绪"; else fail "Server 未就绪，见 $SERVER_LOG"; tail -20 "$SERVER_LOG" | sed 's/^/    /'; exit 1; fi
sleep 1
SERVER_PID="$(cat "$SERVER_PID_FILE")"
info "Server pid = ${SERVER_PID}"
if grep -q 'Render engine active' "$SERVER_LOG"; then
  pass "日志确认 Render 引擎生效：$(grep 'Render engine active' "$SERVER_LOG" | head -1 | sed "s|$ROOT|<repo>|g")"
else
  fail "Server 日志没有 'Render engine active'"
fi
RENDER_META_FILE="$(ls "$DIR"/.render-*.json 2>/dev/null | head -1)"
if [ -n "$RENDER_META_FILE" ]; then
  pass "Render 元数据存在：$(basename "${RENDER_META_FILE}") → $(cat "$RENDER_META_FILE")"
else
  fail "没有 .render-*.json 元数据文件"
fi
RENDER_PID_1="$(render_pid)"
if [ -n "$RENDER_PID_1" ] && process_alive "$RENDER_PID_1"; then
  pass "Render 守护进程已启动（pid ${RENDER_PID_1}）"
else
  fail "没有 Render 进程（检查 .render-*.pid）"; exit 1
fi
file_has_render_socket=0
SOCKET_PATH="$(json_field "$(run_helper render-paths)" socketPath)"
if [ -S "$SOCKET_PATH" ]; then file_has_render_socket=1; pass "Render socket 存在：${SOCKET_PATH}"; else fail "找不到 Render socket ${SOCKET_PATH}"; fi
if [ "$(render_process_count)" = "1" ]; then pass "Render 进程数 = 1"; else fail "Render 进程数 = $(render_process_count)（期望 1）"; fi
info "Render stats = $(run_helper render-stats)"
if ls "$DIR"/.render-*.token >/dev/null 2>&1; then
  TOKEN_SHA_BEFORE="$(sha256_of "$(ls "$DIR"/.render-*.token | head -1)")"
  pass "token 文件存在（sha256 ${TOKEN_SHA_BEFORE:0:12}…，内容不打印）"
else
  TOKEN_SHA_BEFORE=""
  fail "没有 .render-*.token"
fi

# ── 步骤 5：登录 + 建 PTY 会话 ────────────────────────────────────────────
step "步骤 5：登录并创建一个普通 shell 会话"
LOGIN="$(run_helper login)"
if [ "$(json_field "$LOGIN" status)" = "200" ]; then pass "POST /api/login → 200"; else fail "登录失败：$LOGIN"; exit 1; fi

CREATE="$(run_helper create-shell)"
SESSION_ID="$(json_field "$CREATE" sessionId)"
PTY_PID_BEFORE="$(json_field "$CREATE" renderPid)"
if [ -n "$SESSION_ID" ] && [ "$(json_field "$CREATE" status)" = "201" ]; then
  pass "会话已创建：$SESSION_ID"
else
  fail "创建会话失败：$CREATE"; exit 1
fi
info "Render 侧 attach 报的 PTY pid = ${PTY_PID_BEFORE}，尺寸 $(json_field "$CREATE" dtoCols)x$(json_field "$CREATE" dtoRows)"
if [ -n "$PTY_PID_BEFORE" ] && process_alive "$PTY_PID_BEFORE"; then
  PTY_PPID="$(ps -p "$PTY_PID_BEFORE" -o ppid= | tr -d ' ')"
  if [ "$PTY_PPID" = "$RENDER_PID_1" ]; then
    pass "PTY 子进程在 ps 中存在：${PTY_PID_BEFORE}（ppid = Render ${RENDER_PID_1}）"
  else
    fail "PTY ${PTY_PID_BEFORE} 的 ppid = ${PTY_PPID}，期望 Render ${RENDER_PID_1}"
  fi
else
  fail "ps 里找不到 PTY pid $PTY_PID_BEFORE"
fi

# ── 步骤 6：WS + pty_input（文本与 "\r" 分两包）──────────────────────────
step "步骤 6：WebSocket subscribe/init + pty_input（先文本、再单独 \"\\r\"）"
MARK6="WAND_E2E_STEP6_$(date +%s)"
WS6="$(run_helper ws "$SESSION_ID" web "echo $MARK6")"
info "帧类型 = $(json_field "$WS6" codeFrames)"
if [ "$(json_field "$WS6" initSeen)" = "true" ]; then pass "收到 init 帧（terminalState=$(json_field "$WS6" initHasTerminalState)）"; else fail "没有 init 帧：$WS6"; fi
if [ "$(json_field "$WS6" echoFound)" = "true" ]; then pass "output 帧里出现命令回显（${MARK6}）"; else fail "未收到回显：$WS6"; fi
if [ "$(json_field "$WS6" sawPtyError)" = "false" ]; then pass "没有 pty_error"; else fail "出现 pty_error：$WS6"; fi

# ── 步骤 7：Server 重启，Render 与 PTY 必须活着 ───────────────────────────
step "步骤 7：Server 重启 → Render 与 PTY 存活、pid 不变"
OLD_SERVER_PID="$SERVER_PID"
if stop_server "$SERVER_PID_FILE"; then pass "Server ($OLD_SERVER_PID) 已退出"; else fail "Server 未在 30s 内退出"; fi
sleep 1
if process_alive "$RENDER_PID_1"; then pass "Server 死后 Render 仍活着（pid ${RENDER_PID_1}）"; else fail "Render 随 Server 一起死了"; fi
if process_alive "$PTY_PID_BEFORE"; then pass "Server 死后 shell 仍活着（pid ${PTY_PID_BEFORE}）"; else fail "shell 被带走了"; fi
if ls "$DIR"/.render-*.token >/dev/null 2>&1; then pass "token 文件未被清理"; else fail "token 文件消失"; fi

start_server "$CONFIG" "$SERVER_LOG" "$SERVER_PID_FILE" rust "$RENDER_BIN"
if wait_for_http 80; then pass "Server 重启后在 $BASE 就绪（pid $(cat "$SERVER_PID_FILE")）"; else fail "Server 重启失败，见 $SERVER_LOG"; exit 1; fi
SERVER_PID="$(cat "$SERVER_PID_FILE")"
if grep -q "Reattached live terminal $SESSION_ID (pid $PTY_PID_BEFORE)" "$SERVER_LOG"; then
  pass "Server 日志确认重新 attach 同一 pid：$PTY_PID_BEFORE"
else
  fail "没有看到 'Reattached live terminal $SESSION_ID (pid $PTY_PID_BEFORE)'"
  grep -E 'Reattached live terminal|orphan|Recovered' "$SERVER_LOG" | tail -5 | sed 's/^/    /'
fi
RENDER_LIST_7="$(run_helper render-list)"
PTY_PID_AFTER="$(json_field "$RENDER_LIST_7" sessions.0.pid)"
if [ -n "$PTY_PID_AFTER" ] && [ "$PTY_PID_AFTER" = "$PTY_PID_BEFORE" ]; then
  pass "重启前后 PTY pid 完全一致：before=$PTY_PID_BEFORE after=$PTY_PID_AFTER"
else
  fail "PTY pid 变了：before=$PTY_PID_BEFORE after=${PTY_PID_AFTER}（render-list=${RENDER_LIST_7}）"
fi
if [ "$(render_process_count)" = "1" ]; then pass "Render 进程数仍为 1（没有跑出第二个 daemon）"; else fail "Render 进程数 = $(render_process_count)（期望 1）"; ps -ax -o pid=,command= | grep "[w]and-render -c $CONFIG" | sed 's/^/    /'; fi
MARK7="WAND_E2E_STEP7_$(date +%s)"
WS7="$(run_helper ws "$SESSION_ID" web "echo $MARK7")"
if [ "$(json_field "$WS7" echoFound)" = "true" ]; then pass "重启后输入仍有输出（continuity 成立）"; else fail "重启后拿不到输出：$WS7"; fi

# ── 步骤 8：Render 崩溃 → Server 自愈（重新拉起 daemon + token 重读）──────
step "步骤 8：kill -9 Render → Server 自己重新拉起 daemon（token 轮换）"
kill -9 "$RENDER_PID_1" 2>/dev/null || true
sleep 1
if process_alive "$RENDER_PID_1"; then fail "Render 没被杀掉"; else pass "Render ($RENDER_PID_1) 已被 kill -9"; fi
if process_alive "$PTY_PID_BEFORE"; then fail "旧 daemon 里的 PTY ${PTY_PID_BEFORE} 竟然还活着"; else pass "旧 daemon 里的 PTY ${PTY_PID_BEFORE} 随 daemon 消失（符合预期）"; fi

# 这里不再由本脚本代劳：崩溃后端点（socket 文件）也失效了，重连一万次都不会成功，
# Server 必须自己把 daemon 拉回来（src/render-host.ts: createRenderDaemonReviver）。
RENDER_PID_2=""
for _ in $(seq 1 60); do
  RENDER_PID_2="$(render_pid)"
  if [ -n "$RENDER_PID_2" ] && [ "$RENDER_PID_2" != "$RENDER_PID_1" ] && process_alive "$RENDER_PID_2"; then break; fi
  RENDER_PID_2=""
  sleep 0.5
done
if [ -n "$RENDER_PID_2" ] && [ "$RENDER_PID_2" != "$RENDER_PID_1" ]; then
  pass "Server 自己把 Render 拉回来了（新 pid ${RENDER_PID_2}）"
else
  fail "Server 没有自愈：Render 崩溃后没被重新拉起（pid=${RENDER_PID_2}；Server 日志里应出现 'Restarted Render daemon'）"
fi
TOKEN_SHA_AFTER="$(sha256_of "$(ls "$DIR"/.render-*.token | head -1)" 2>/dev/null || true)"
if [ -n "$TOKEN_SHA_BEFORE" ] && [ -n "$TOKEN_SHA_AFTER" ] && [ "$TOKEN_SHA_BEFORE" != "$TOKEN_SHA_AFTER" ]; then
  pass "token 已轮换（sha256 ${TOKEN_SHA_BEFORE:0:12}… → ${TOKEN_SHA_AFTER:0:12}…），旧 Server 必须重读它"
else
  fail "token 没有轮换（before=${TOKEN_SHA_BEFORE:0:12}… after=${TOKEN_SHA_AFTER:0:12}…）"
fi
# 旧客户端必须重读到轮换后的 token 才能 adopt；否则 createOrAttach 会一直失败。
NEW_SESSION=""
CREATE2=""
for _ in $(seq 1 20); do
  CREATE2="$(run_helper create-shell)"
  NEW_SESSION="$(json_field "$CREATE2" sessionId)"
  if [ -n "$NEW_SESSION" ] && [ "$(json_field "$CREATE2" status)" = "201" ]; then break; fi
  NEW_SESSION=""
  sleep 1
done
if [ -n "$NEW_SESSION" ]; then
  pass "daemon 重启后仍能建新会话（${NEW_SESSION}）：旧 Server 已用轮换后的 token 重连"
else
  fail "daemon 重启后建会话失败（token 没有重读）：status=$(json_field "$CREATE2" status) $(json_field "$CREATE2" bodyPreview)"
fi
# 旧会话的 PTY 随旧 daemon 消失，Server 侧必须把它落成 exited 而不是永远 running。
OLD_STATUS=""
for _ in $(seq 1 40); do
  OLD_STATUS="$(json_field "$(run_helper session-status "$SESSION_ID")" sessionStatus)"
  [ "$OLD_STATUS" != "running" ] && break
  sleep 0.5
done
if [ "$OLD_STATUS" != "running" ] && [ -n "$OLD_STATUS" ]; then
  pass "被 kill 掉的 daemon 里那条会话已落库为 ${OLD_STATUS}（不再永远 running）"
else
  fail "旧会话仍停在 ${OLD_STATUS}（reconcileAfterReconnect 没有生效）"
fi
if [ "$(render_process_count)" = "1" ]; then pass "自愈期间 Render 进程数 = 1"; else fail "Render 进程数 = $(render_process_count)（期望 1）"; fi

# ── 步骤 9：Web / Android profile + embed 入口（需要活的 Render）──────────
step "步骤 9：客户端兼容性（Web profile / Android profile / embed 入口）"
if [ -z "$NEW_SESSION" ]; then
  fail "没有可用于 profile 校验的会话，跳过"
else
  MARK9A="WAND_E2E_STEP9_WEB_$(date +%s)"
  WS9A="$(run_helper ws "$NEW_SESSION" web "echo $MARK9A")"
  if [ "$(json_field "$WS9A" echoFound)" = "true" ]; then
    pass "Web profile（不带 capabilities）：init/output/回显正常，帧=$(json_field "$WS9A" codeFrames)"
  else
    fail "Web profile 失败：$WS9A"
  fi
  MARK9B="WAND_E2E_STEP9_ANDROID_$(date +%s)"
  WS9B="$(run_helper ws "$NEW_SESSION" android "echo $MARK9B")"
  if [ "$(json_field "$WS9B" echoFound)" = "true" ] \
    && [ "$(json_field "$WS9B" sawPtyError)" = "false" ] \
    && [ "$(json_field "$WS9B" sawResyncRequired)" = "false" ]; then
    pass "Android profile（capabilities.ptyAck）：回显正常，回 ack $(json_field "$WS9B" ackCount) 次，无 pty_error/resync_required"
  else
    fail "Android profile 失败：$WS9B"
  fi
fi
EMBED="$(run_helper embed)"
if [ "$(json_field "$EMBED" status)" = "200" ] && [ "$(json_field "$EMBED" isHtml)" = "true" ]; then
  pass "GET /?embed=terminal&nativeInput=1 → 200 $(json_field "$EMBED" contentType)（Android PTY 页入口）"
else
  fail "embed 入口异常：$EMBED"
fi

# ── 步骤 10：drain 必须保留 PTY（协议 §9.3）───────────────────────────────
step "步骤 10：drain 保留 PTY，随后 now 才真正停止"
NEW_SESSION_PID="$(json_field "$(run_helper render-list)" sessions.0.pid)"
info "要保住的会话 ${NEW_SESSION} 的 PTY pid = ${NEW_SESSION_PID}"
DRAIN_ACK="$(run_helper render-shutdown drain)"
if [ -n "$DRAIN_ACK" ] && [ "$(json_field "$DRAIN_ACK" error 2>/dev/null)" = "" ]; then
  pass "shutdown {mode:drain} 已被接受：${DRAIN_ACK}"
else
  fail "shutdown drain 失败：${DRAIN_ACK}"
fi
sleep 1.5
if process_alive "$RENDER_PID_2"; then pass "drain 1.5s 后 daemon 仍在（pid ${RENDER_PID_2}）"; else fail "drain 把 daemon 杀了（§9.3 要求进程继续存活）"; fi
if [ -n "$NEW_SESSION_PID" ] && process_alive "$NEW_SESSION_PID"; then pass "drain 1.5s 后 PTY 子进程仍在（pid ${NEW_SESSION_PID}）"; else fail "drain 把 PTY 杀了（pid=${NEW_SESSION_PID}）"; fi
DRAIN_ATTACH="$(run_helper render-list)"
if [ "$(json_field "$DRAIN_ATTACH" sessions.0.status)" = "running" ]; then
  pass "drain 后 attach/list 仍报 running"
else
  fail "drain 后会话状态 = $(json_field "$DRAIN_ATTACH" sessions.0.status)（期望 running）"
fi
DRAIN_CREATE="$(run_helper create-shell)"
if [ "$(json_field "$DRAIN_CREATE" status)" = "201" ]; then
  fail "drain 之后新会话仍然建成功（§9.3 要求拒绝新会话）"
else
  pass "drain 之后新会话被拒绝：/api/commands → $(json_field "$DRAIN_CREATE" status)（$(json_field "$DRAIN_CREATE" bodyPreview)）"
fi
if [ -n "$NEW_SESSION_PID" ] && process_alive "$NEW_SESSION_PID"; then pass "被拒绝的建会话没有影响运行中的 PTY"; else fail "建会话被拒后 PTY 也没了"; fi
NOW_ACK="$(run_helper render-shutdown now)"
sleep 1
if process_alive "$RENDER_PID_2"; then fail "shutdown {mode:now} 之后 daemon 仍在（pid ${RENDER_PID_2}）"; else pass "shutdown {mode:now} 之后 daemon 已退出"; fi
if [ -n "$NEW_SESSION_PID" ] && process_alive "$NEW_SESSION_PID"; then fail "now 之后 PTY ${NEW_SESSION_PID} 仍在"; else pass "now 之后 PTY ${NEW_SESSION_PID} 已消失"; fi
if [ "$(render_process_count)" = "0" ]; then pass "now 之后没有再跑出新的 Render 进程"; else fail "now 之后仍有 $(render_process_count) 个 Render 进程"; fi

# ── 步骤 11：stub / dev 路径 / legacy 回滚路径 ─────────────────────────────
step "步骤 11：产物与回滚路径抽查（stub / 删除 dist/native 的开发态 / engine=legacy）"

# 子实例都用同一个 ${PORT}：先停掉主 Server 并等端口真的空出来，
# 否则后面的 "$BASE 就绪" 会打在旧实例上、断言变成假 PASS。
stop_server "$SERVER_PID_FILE" >/dev/null 2>&1 || true
if wait_for_port_free; then
  pass "主 Server 已停止，端口 $PORT 已释放（后续子实例复用同一端口）"
else
  fail "停止主 Server 后端口 $PORT 仍被占用（子实例断言会打在旧实例上）"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/    /'
fi

# 11a：伪 stub 必须让 engine=rust 明确失败，而不是静默降级。
STUB_DIR="$DIR/probe-stub"
mkdir -p "$STUB_DIR"
cat >"$STUB_DIR/stub-wand-render" <<'STUB_EOF'
#!/bin/sh
echo "wand-render 0.1.0 (stub)"
exit 0
STUB_EOF
chmod +x "$STUB_DIR/stub-wand-render"
node -e '
const fs = require("fs");
const crypto = require("crypto");
const [p, port] = process.argv.slice(1);
fs.writeFileSync(p, JSON.stringify({ host: "127.0.0.1", port: Number(port), https: false,
  password: crypto.randomBytes(16).toString("hex"), defaultCwd: require("path").dirname(p), defaultMode: "default" }, null, 2));
' "$STUB_DIR/config.json" "$PORT"
: >"$STUB_DIR/server.log"
start_server "$STUB_DIR/config.json" "$STUB_DIR/server.log" "$STUB_DIR/server.pid" rust "$STUB_DIR/stub-wand-render"
STUB_SERVER_PID="$(cat "$STUB_DIR/server.pid")"
if wait_for_exit "$STUB_SERVER_PID" 30; then
  STUB_EXIT_MESSAGE="$(grep -m1 'did not become ready' "$STUB_DIR/server.log" || true)"
  if [ -n "$STUB_EXIT_MESSAGE" ]; then
    pass "伪 stub 让 engine=rust 启动失败并给出清晰错误：$(printf '%s' "$STUB_EXIT_MESSAGE" | sed "s|$DIR|<dir>|g")"
  else
    fail "engine=rust + 伪 stub 退出了，但没有明确报错：$(tail -3 "$STUB_DIR/server.log" | tr '\n' ' ')"
  fi
  if port_busy; then fail "stub 失败后端口 $PORT 仍被占用（残留 Server 进程）"; else pass "stub 失败后端口 $PORT 已释放（没有半启动的 Server）"; fi
else
  fail "伪 stub 下 Server 竟然没退出（engine=rust 不能静默降级）"
  kill -TERM "$STUB_SERVER_PID" 2>/dev/null || true
fi
rm -f "$(json_field "$(run_helper_at "$STUB_DIR/config.json" "$STUB_DIR/cookie.txt" "$STUB_DIR" render-paths)" socketPath)" 2>/dev/null || true
if wait_for_port_free; then pass "stub 用例收尾：端口 $PORT 已释放"; else fail "stub 用例收尾：端口 $PORT 仍被占用"; fi

# 11b：删掉 dist/native 后，engine=rust 仍要能用 render/target/release（开发态路径）。
DEV_DIR="$DIR/probe-dev"
mkdir -p "$DEV_DIR"
node -e '
const fs = require("fs");
const crypto = require("crypto");
const [p, port] = process.argv.slice(1);
fs.writeFileSync(p, JSON.stringify({ host: "127.0.0.1", port: Number(port), https: false,
  password: crypto.randomBytes(16).toString("hex"), defaultCwd: require("path").dirname(p), defaultMode: "default" }, null, 2));
' "$DEV_DIR/config.json" "$PORT"
: >"$DEV_DIR/server.log"
DEV_BACKUP="/tmp/wand-e2e-dist-native-backup.$$"
MOVED_DIST_NATIVE=0
if [ -d "$ROOT/dist/native" ]; then mv "$ROOT/dist/native" "$DEV_BACKUP"; MOVED_DIST_NATIVE=1; info "临时把 dist/native 移到 ${DEV_BACKUP}"; fi
DEV_BINARY_EXPECTED="$ROOT/render/target/release/wand-render"
if [ -x "$DEV_BINARY_EXPECTED" ]; then
  # (1) 纯解析断言：不设 WAND_RENDER_BIN 且没有 dist/native 时，解析结果必须是 render/target/release。
  #     这一条不依赖产物是否可用，专门锁定「候选顺序」这个布局契约。
  RESOLVED="$(env -u WAND_RENDER_BIN node --input-type=module -e '
const { resolveRenderBinaryPath } = await import(process.argv[1]);
console.log(resolveRenderBinaryPath(process.argv[2]));
' "$ROOT/dist/render-binary.js" "$DEV_DIR/config.json" 2>/dev/null)"
  if [ "$RESOLVED" = "$DEV_BINARY_EXPECTED" ]; then
    pass "dist/native 不存在时，自动发现选中开发态产物：${RESOLVED#${ROOT}/}"
  else
    fail "dist/native 不存在时的自动发现结果不对：${RESOLVED:-（空）}（期望 ${DEV_BINARY_EXPECTED}）"
  fi
  # (2) 运行时断言：该产物能用（能起 Server、能建会话）才跑；否则根因已在步骤 3b 报过，
  #     这里不重复计一次 FAIL，但要明确说清楚跳过原因（不是静默放过）。
  if [ "$DEV_BINARY_ADOPTABLE" = "yes" ]; then
    start_server "$DEV_DIR/config.json" "$DEV_DIR/server.log" "$DEV_DIR/server.pid" rust ""
    if wait_for_http 80; then
      pass "删除 dist/native 后仍能启动（自动发现 ${DEV_BINARY_EXPECTED#$ROOT/}）"
      DEV_ACTIVE_LINE="$(grep -m1 'Render engine active' "$DEV_DIR/server.log" || true)"
      if printf '%s' "$DEV_ACTIVE_LINE" | grep -q "render/target/release/wand-render"; then
        pass "日志确认用的是开发态产物：$(printf '%s' "$DEV_ACTIVE_LINE" | sed "s|$ROOT|<repo>|g")"
      else
        fail "启动日志里的产物不是 render/target/release：${DEV_ACTIVE_LINE}"
      fi
      DEV_LOGIN="$(run_helper_at "$DEV_DIR/config.json" "$DEV_DIR/cookie.txt" "$DEV_DIR" login)"
      DEV_CREATE="$(run_helper_at "$DEV_DIR/config.json" "$DEV_DIR/cookie.txt" "$DEV_DIR" create-shell)"
      if [ "$(json_field "$DEV_LOGIN" status)" = "200" ] && [ "$(json_field "$DEV_CREATE" status)" = "201" ] && [ -n "$(json_field "$DEV_CREATE" renderPid)" ]; then
        pass "开发态 Render 能建会话并 attach（pid $(json_field "$DEV_CREATE" renderPid)）"
      else
        fail "开发态 Render 建会话失败：login=$(json_field "$DEV_LOGIN" status) create=$(json_field "$DEV_CREATE" status) $(json_field "$DEV_CREATE" bodyPreview)"
      fi
      run_helper_at "$DEV_DIR/config.json" "$DEV_DIR/cookie.txt" "$DEV_DIR" render-shutdown now >/dev/null 2>&1
    else
      fail "删除 dist/native 后 engine=rust 起不来：$(tail -3 "$DEV_DIR/server.log" | tr '\n' ' ')"
    fi
    stop_server "$DEV_DIR/server.pid" >/dev/null 2>&1 || true
  else
    info "SKIP 运行时子检查：${DEV_BINARY_EXPECTED#${ROOT}/} 的寻址与 Node 分叉（步骤 3b 已 FAIL），起 Server 必然失败"
  fi
else
  info "SKIP 开发态路径检查：${DEV_BINARY_EXPECTED} 不存在（跑 npm run build:render-native 生成）"
fi
if [ "$MOVED_DIST_NATIVE" = "1" ]; then
  rm -rf "$ROOT/dist/native"
  mv "$DEV_BACKUP" "$ROOT/dist/native"
  pass "dist/native 已恢复"
fi
DEV_RENDER_PID="$(cat "$DEV_DIR"/.render-*.pid 2>/dev/null | head -1)"
if [ -n "$DEV_RENDER_PID" ] && process_alive "$DEV_RENDER_PID"; then kill -TERM "$DEV_RENDER_PID" 2>/dev/null || true; fi
if wait_for_port_free; then pass "dev 用例收尾：端口 $PORT 已释放"; else fail "dev 用例收尾：端口 $PORT 仍被占用"; fi

# 11c：engine=legacy 必须仍然可用（回滚路径）。
LEGACY_DIR="$DIR/probe-legacy"
mkdir -p "$LEGACY_DIR"
node -e '
const fs = require("fs");
const crypto = require("crypto");
const [p, port] = process.argv.slice(1);
fs.writeFileSync(p, JSON.stringify({ host: "127.0.0.1", port: Number(port), https: false,
  password: crypto.randomBytes(16).toString("hex"), defaultCwd: require("path").dirname(p), defaultMode: "default" }, null, 2));
' "$LEGACY_DIR/config.json" "$PORT"
: >"$LEGACY_DIR/server.log"
start_server "$LEGACY_DIR/config.json" "$LEGACY_DIR/server.log" "$LEGACY_DIR/server.pid" legacy ""
if wait_for_http 80; then
  pass "engine=legacy 在 $BASE 就绪（回滚路径可用）"
  LEGACY_LOGIN="$(run_helper_at "$LEGACY_DIR/config.json" "$LEGACY_DIR/cookie.txt" "$LEGACY_DIR" login)"
  LEGACY_CREATE="$(run_helper_at "$LEGACY_DIR/config.json" "$LEGACY_DIR/cookie.txt" "$LEGACY_DIR" create-shell)"
  LEGACY_SESSION="$(json_field "$LEGACY_CREATE" sessionId)"
  if [ "$(json_field "$LEGACY_LOGIN" status)" = "200" ] && [ "$(json_field "$LEGACY_CREATE" status)" = "201" ]; then
    MARK11="WAND_E2E_STEP11_LEGACY_$(date +%s)"
    LEGACY_WS="$(run_helper_at "$LEGACY_DIR/config.json" "$LEGACY_DIR/cookie.txt" "$LEGACY_DIR" ws "$LEGACY_SESSION" web "echo $MARK11")"
    if [ "$(json_field "$LEGACY_WS" echoFound)" = "true" ]; then
      pass "legacy 引擎下 PTY 会话 + WS 回显正常（${LEGACY_SESSION}）"
    else
      fail "legacy 引擎下拿不到回显：$LEGACY_WS"
    fi
    if ps -ax -o command= | grep -qE "[w]and-render -c $LEGACY_DIR/config.json"; then
      fail "engine=legacy 却起了 wand-render 进程"
    else
      pass "engine=legacy 没有起任何 wand-render 进程（全程走 legacy terminald）"
    fi
  else
    fail "legacy 引擎建会话失败：login=$(json_field "$LEGACY_LOGIN" status) create=$(json_field "$LEGACY_CREATE" status) $(json_field "$LEGACY_CREATE" bodyPreview)"
  fi
else
  fail "engine=legacy 起不来（回滚路径失效）：$(tail -3 "$LEGACY_DIR/server.log" | tr '\n' ' ')"
fi
stop_server "$LEGACY_DIR/server.pid" >/dev/null 2>&1 || true
if wait_for_port_free; then pass "legacy 用例收尾：端口 $PORT 已释放"; else fail "legacy 用例收尾：端口 $PORT 仍被占用"; fi

# ── 步骤 12：清理 ──────────────────────────────────────────────────────────
step "步骤 12：清理"
stop_server "$SERVER_PID_FILE" >/dev/null 2>&1 || info "主 Server 未在 30s 内退出"
pass "主 Server 已停止"
for pidfile in "$DIR"/probe-*/server.pid; do
  [ -f "$pidfile" ] || continue
  stop_server "$pidfile" >/dev/null 2>&1 || true
done
# legacy terminald 由 Server detached 启动，不属于任何 server.pid；按 config 精确定位后收尾。
LEGACY_DAEMON_PIDS="$(pgrep -f "terminald -c $LEGACY_DIR/config.json" || true)"
if [ -n "$LEGACY_DAEMON_PIDS" ]; then
  printf '%s\n' "$LEGACY_DAEMON_PIDS" | xargs kill -TERM 2>/dev/null || true
  sleep 1
fi
run_helper render-shutdown now >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  [ -z "$(render_pid)" ] && break
  sleep 0.5
done
if ls "$DIR"/.render-*.pid "$DIR"/.render-*.token "$DIR"/.render-*.json >/dev/null 2>&1; then
  fail "Render 的 pid/token/meta 文件没有清理干净"
else
  pass "Render 的 pid/token/meta 文件已清理"
fi
if [ "$file_has_render_socket" = "1" ] && [ -e "$SOCKET_PATH" ]; then
  fail "Render socket 文件没有清理：${SOCKET_PATH}"
else
  pass "Render socket 文件已清理"
fi
# 只数本次隔离目录相关的进程：机器上别的 Wand 实例可能有自己的 Render，不能算残留。
STRAY_RENDER="$(isolated_render_count)"
if [ "$STRAY_RENDER" = "0" ]; then pass "没有残留本次验证的 wand-render 进程"; else fail "仍有 ${STRAY_RENDER} 个 wand-render 进程"; ps -ax -o pid=,command= | grep "[w]and-render -c" | sed 's/^/    /'; fi
rm -rf "$DIR"
if [ -d "$DIR" ]; then fail "隔离目录未删除"; else pass "隔离目录 $DIR 已删除"; fi

# ── 汇总 ────────────────────────────────────────────────────────────────────
printf '\n=== 汇总 ===\n'
printf 'PASS %d / FAIL %d\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  info "失败时保留构建日志：${BUILD_LOG}"
  exit 1
fi
rm -f "$BUILD_LOG"
exit 0
