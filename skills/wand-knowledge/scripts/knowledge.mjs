import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

try {
  const [operation, ...args] = process.argv.slice(2);
  if (!["search", "read", "remember", "update", "forget"].includes(operation)) throw new Error("仅支持 search、read、remember、update、forget。");
  if (args.some(arg => ["--config", "-c"].includes(arg))) throw new Error("知识库只能使用当前会话绑定的配置。");
  const runtime = JSON.parse(await readFile(new URL("../.runtime.json", import.meta.url), "utf8"));
  if (![runtime.node, runtime.cli].every(value => typeof value === "string" && isAbsolute(value))) throw new Error("技能运行路径无效，请重新同步 Wand 托管技能。");
  const child = spawn(runtime.node, [...(runtime.loader ? ["--import", runtime.loader] : []), runtime.cli, `knowledge:${operation}`, ...args], { stdio: "inherit" });
  child.on("error", () => { process.stderr.write("wand-knowledge: CLI 无法启动，请重新同步技能。\n"); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} catch (error) {
  process.stderr.write(`wand-knowledge: ${error.code === "ENOENT" ? "请先启动 Wand 同步技能。" : error.message}\n`);
  process.exitCode = 1;
}
