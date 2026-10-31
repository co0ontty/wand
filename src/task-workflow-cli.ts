import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WandStorage } from "./storage.js";

/** Never opens owner CLI authentication as a fallback. Exact task and runtime grant only. */
export async function runTaskWorkflowCli(args: string[], input: AsyncIterable<string | Buffer> = process.stdin): Promise<void> {
  if (args.length !== 2 || !args[0] || args[0].startsWith("-") || args[1] !== "--stdin") throw new Error("用法：wand task:workflow <task-id> --stdin");
  const database = process.env.WAND_TASK_DB ?? "", token = process.env.WAND_TASK_TOKEN ?? "";
  if (!isAbsolute(database) || !existsSync(database) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("任务回填仅可在有任务级授权的 Wand 员工执行中使用，不能使用所有者登录替代。");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 96_000) throw new Error("任务回填内容过长。");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const storage = new WandStorage(database);
  try {
    const task = storage.applyEmployeeTaskWorkflow(token, args[0], value);
    process.stdout.write(JSON.stringify({ saved: true, task }) + "\n");
  } finally { storage.close(); }
}
