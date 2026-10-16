import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const args = process.argv.slice(2);
const allowed = new Set([
  "employee:list", "workspace:list", "session:current", "session:list", "session:read",
  "session:create", "session:resume", "session:wait", "schedule:list", "schedule:read",
  "schedule:create", "schedule:update",
]);
try {
  if (!allowed.has(args[0]) || args.some(arg => ["--config", "-c"].includes(arg))) {
    throw new Error("仅支持 wand-system 文档列出的操作，不能覆盖绑定的配置。");
  }
  if (args[0] === "session:current") {
    if (args.length !== 1 || !process.env.WAND_SESSION_ID) throw new Error("当前执行环境未绑定会话 ID；请从 Wand 当前会话详情取得精确 ID，不按标题猜测。");
    process.stdout.write(JSON.stringify({ sessionId: process.env.WAND_SESSION_ID }) + "\n");
  } else {
    const runtime = JSON.parse(await readFile(new URL("../.runtime.json", import.meta.url), "utf8"));
    if (![runtime.node, runtime.cli, runtime.config].every(value => typeof value === "string" && isAbsolute(value))) {
      throw new Error("技能运行路径无效，请用可信 Wand CLI 重新运行 system:skills。");
    }
    const child = spawn(runtime.node, [
      ...(runtime.loader ? ["--import", runtime.loader] : []),
      runtime.cli, ...args, "--config", runtime.config,
    ], { stdio: "inherit" });
    child.on("error", () => { process.stderr.write("wand-system: CLI 无法启动，请重新安装技能。\n"); process.exitCode = 1; });
    child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  }
} catch (error) {
  process.stderr.write(`wand-system: ${error.code === "ENOENT" ? "请先运行 wand system:skills 安装技能。" : error.message}\n`);
  process.exitCode = 1;
}
