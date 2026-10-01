import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WandStorage } from "./storage.js";
import type { EmployeeKnowledgeEntry } from "./employee-knowledge-types.js";

async function readKnowledgeStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_000) throw new Error("知识内容过长。");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Does not accept an employee selector or use the default employee when scope is absent. */
export async function runEmployeeKnowledgeCli(command: string, args: string[]): Promise<void> {
  const dbPath = process.env.WAND_KNOWLEDGE_DB ?? "";
  const token = process.env.WAND_KNOWLEDGE_TOKEN ?? "";
  if (!isAbsolute(dbPath) || !existsSync(dbPath) || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("知识库工具仅可在 Wand 员工会话的有效执行环境中使用。");
  }
  const storage = new WandStorage(dbPath);
  try {
    const employeeId = storage.resolveEmployeeKnowledgeAccess(token);
    if (!employeeId) throw new Error("当前员工知识库访问已失效，不能改存到其他员工。");
    let result: { saved?: boolean; entry?: EmployeeKnowledgeEntry; entries?: EmployeeKnowledgeEntry[]; deleted?: boolean };
    if (command === "knowledge:remember") {
      if (args.length !== 1) throw new Error("用法：knowledge:remember <一条文字> 或 --stdin。");
      const content = args[0] === "--stdin" ? await readKnowledgeStdin() : args[0]!;
      result = { saved: true, entry: storage.rememberEmployeeKnowledge(employeeId, content, token) };
    } else if (command === "knowledge:search") {
      if (args.length > 1) throw new Error("用法：knowledge:search [关键词]。");
      result = { entries: storage.listEmployeeKnowledge(employeeId, args[0] ?? "", 20) };
    } else if (command === "knowledge:forget") {
      if (args.length !== 1 || !/^k_[a-f0-9]{32}$/.test(args[0]!)) throw new Error("用法：knowledge:forget <知识条目id>。");
      result = { deleted: storage.forgetEmployeeKnowledge(employeeId, args[0]!, token) };
    } else throw new Error("未知知识库操作。");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { storage.close(); }
}
