import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

function failure(code, requestId) {
  if (!["CANCELLED", "ORIGIN_MISMATCH", "ISSUANCE_REJECTED", "CONSUMPTION_REJECTED", "DELIVERY_UNKNOWN", "CLI_UNAVAILABLE", "INVALID_RESULT", "DEBUG_LOGGING", "EXECUTION_PROOF_REQUIRED"].includes(code)) code = "DELIVERY_UNKNOWN";
  const error = new Error(code === "EXECUTION_PROOF_REQUIRED"
    ? `Web 登录未发起 (${code})：当前进程缺少 Wand 员工执行证明。独立启动的 Pi/终端不会获得此证明；请在 Wand 内已获授权的员工会话新一轮执行中登录，或由用户手动登录。不要手填会话 ID、复制证明或回退到所有者身份。requestId=${requestId}`
    : `Web 登录${code === "CANCELLED" ? "已取消" : "未确认"} (${code})；请核对浏览器登录状态，不要自动重试。requestId=${requestId}`);
  error.code = code;
  error.requestId = requestId;
  return error;
}

// This is only an availability check. The server still validates the proof and live actor.
function checkIssuanceContext(requestId, signal) {
  if (signal?.aborted) throw failure("CANCELLED", requestId);
  if (process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG) throw failure("DEBUG_LOGGING", requestId);
  if (!/^wlp_[a-zA-Z0-9_-]{43}$/.test(process.env.WAND_WEB_LOGIN_PROOF ?? "")) {
    throw failure("EXECUTION_PROOF_REQUIRED", requestId);
  }
}

/** Capture the CLI in a bounded anonymous process pipe. Never attach this stdout to a tool transcript. */
function call(command, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(failure("CANCELLED", body.requestId)); return; }
    if (process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG) { reject(failure("DEBUG_LOGGING", body.requestId)); return; }
    const child = spawn(process.execPath, [fileURLToPath(new URL("./wand.mjs", import.meta.url)), command, "--stdin"], {
      stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, WAND_WEB_LOGIN_PIPE: "1" },
    });
    let output = "", oversized = false, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      output = "";
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { child.kill("SIGTERM"); finish(failure("CANCELLED", body.requestId)); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(failure("DELIVERY_UNKNOWN", body.requestId)); }, 40_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 16_384) { oversized = true; output = ""; child.kill("SIGTERM"); }
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish(failure("CLI_UNAVAILABLE", body.requestId)));
    child.on("close", code => {
      if (code !== 0 || oversized) {
        let reason = "DELIVERY_UNKNOWN";
        try { if (!oversized && JSON.parse(output)?.error?.code === "ISSUANCE_REJECTED") reason = "ISSUANCE_REJECTED"; } catch {}
        finish(failure(reason, body.requestId)); return;
      }
      try { finish(null, JSON.parse(output)); } catch { finish(failure("DELIVERY_UNKNOWN", body.requestId)); }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

export async function issueWebLoginTicket({ origin, requestId }, { signal } = {}) {
  checkIssuanceContext(requestId, signal);
  const result = await call("web-login:issue", { origin, requestId }, signal);
  if (result.origin !== origin || result.requestId !== requestId || !/^wlt_[a-zA-Z0-9_-]{43}$/.test(result.ticket ?? "")
    || result.principal?.kind !== "browser-admin" || JSON.stringify(result.principal?.scopes) !== '["admin"]'
    || !result.subject?.sessionId || !result.subject?.employeeId) {
    throw failure("INVALID_RESULT", requestId);
  }
  return result;
}

export async function cancelWebLoginTicket(requestId) { return call("web-login:cancel", { requestId }); }

/** Playwright Page supplied by the caller. Uses ONLY the visible product login form; no cookie/API injection. */
export async function loginWithWebTicket(page, { origin, signal } = {}) {
  const url = new URL(origin);
  if (url.origin !== origin || new URL(page.url()).origin !== origin) throw failure("ORIGIN_MISMATCH", "not-issued");
  await page.locator('#login-form, #app[data-react-shell="enabled"] .main-content').first().waitFor({ state: "visible", timeout: 30_000 });
  if (!(await page.locator("#login-form").isVisible())) return { status: "not-required", credentialRead: false };
  const requestId = randomUUID();
  // Fail before invoking CLI or entering cancellation cleanup: nothing was issued.
  // Already-authenticated pages above do not require an execution proof.
  checkIssuanceContext(requestId, signal);
  let ticket;
  try {
    if (signal?.aborted) throw failure("CANCELLED", requestId);
    ticket = await issueWebLoginTicket({ origin, requestId }, { signal });
    if (signal?.aborted) throw failure("CANCELLED", requestId);
    if (new URL(page.url()).origin !== origin) throw failure("ORIGIN_MISMATCH", requestId);
    const input = page.locator("#password");
    await input.fill(ticket.ticket);
    ticket = undefined;
    if (signal?.aborted) throw failure("CANCELLED", requestId);
    const response = page.waitForResponse(res => {
      const url = new URL(res.url());
      return url.origin === origin && url.pathname === "/api/login/ticket" && res.request().method() === "POST";
    }, { timeout: 30_000 }).catch(() => null);
    await page.locator("#login-button").click();
    const accepted = await response;
    if (!accepted) throw failure("DELIVERY_UNKNOWN", requestId);
    if (!accepted.ok()) {
      const status = accepted.status();
      throw failure(status >= 400 && status < 500 && ![408, 409].includes(status) ? "CONSUMPTION_REJECTED" : "DELIVERY_UNKNOWN", requestId);
    }
    await page.locator('#app[data-react-shell="enabled"] .main-content').first().waitFor({ state: "visible", timeout: 30_000 });
    return { status: "authenticated", credentialRead: false, requestId, permission: "admin" };
  } catch (error) {
    ticket = undefined;
    // Cancellation is best-effort, idempotent, and never logs a credential. It cannot undo a consumed login.
    await cancelWebLoginTicket(requestId).catch(() => {});
    await page.locator("#password").fill("").catch(() => {});
    throw failure(signal?.aborted ? "CANCELLED" : error?.code ?? "DELIVERY_UNKNOWN", requestId);
  }
}
