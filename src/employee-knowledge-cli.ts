import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WandStorage } from "./storage.js";
import { GLOBAL_KNOWLEDGE_OWNER_ID, KnowledgeError, type KnowledgeScope } from "./knowledge-types.js";

async function readKnowledgeStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 48_000) throw new Error("知识内容过长。");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function options(args: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--stdin") { if (stdin) throw new Error("重复的 --stdin。"); stdin = true; }
    else if (["--scope", "--title", "--folder", "--revision"].includes(arg)) {
      if (flags[arg] !== undefined || args[i + 1] === undefined || args[i + 1]!.startsWith("--")) throw new Error(`参数 ${arg} 需要一个值且不能重复。`);
      flags[arg] = args[++i]!;
    } else if (arg.startsWith("--")) throw new Error("不支持的知识库参数，不能指定其他员工或项目。");
    else positional.push(arg);
  }
  const scope = flags["--scope"] ?? "personal";
  if (scope !== "global" && scope !== "personal" && scope !== "project") throw new Error("--scope 只能为 global、personal 或 project。");
  const revision = flags["--revision"] === undefined ? undefined : Number(flags["--revision"]);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error("版本必须是读取文档时返回的正整数。");
  return { positional, stdin, scope: scope as KnowledgeScope, revision, title: flags["--title"], folder: flags["--folder"] };
}

/** Current persisted identity only; no owner selector or default-role fallback. */
export async function runEmployeeKnowledgeCli(command: string, args: string[]): Promise<void> {
  const dbPath = process.env.WAND_KNOWLEDGE_DB ?? "";
  const token = process.env.WAND_KNOWLEDGE_TOKEN ?? "";
  if (!isAbsolute(dbPath) || !existsSync(dbPath) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("知识库工具仅可在 Wand 会话的有效执行环境中使用。");
  const storage = new WandStorage(dbPath);
  try {
    const opts = options(args);
    const access = storage.resolveKnowledgeAccess(token);
    const legacy = access ? null : storage.resolveEmployeeKnowledgeAccess(token);
    if (!access && !legacy) throw new Error("知识库访问已失效，请等待新的会话执行；不能改存到其他归属。");
    if (legacy && opts.scope !== "personal") throw new Error("旧会话仅授权当前员工知识库，请新开一轮执行使用项目库。");
    const ownerId = opts.scope === "global" ? GLOBAL_KNOWLEDGE_OWNER_ID : opts.scope === "personal" ? access?.employeeId ?? legacy : access?.workspaceId;
    if (!ownerId) throw new Error(`当前会话未绑定${opts.scope === "personal" ? "员工" : "项目"}知识库，不能改存到另一库。`);
    const scopedToken = access ? token : undefined;
    const [id, text] = opts.positional;
    let result: unknown;
    const assertNoEditFlags = () => {
      if (opts.stdin || opts.title !== undefined || opts.folder !== undefined || opts.revision !== undefined) throw new Error("读取操作不接受编辑参数。");
    };
    if (command === "knowledge:search") {
      assertNoEditFlags();
      if (opts.positional.length > 1) throw new Error("用法：knowledge:search [查询文字] [--scope global|personal|project]。");
      const library = storage.readKnowledgeLibrary(opts.scope, ownerId, id ?? "", scopedToken);
      result = { scope: opts.scope, ownerId, total: library.total, matched: library.entries.length,
        entries: library.entries.map(({ id: entryId, title, folder, revision, updatedAt }) => ({ id: entryId, title, folder, revision, updatedAt })),
        hint: "使用 knowledge:read <id> 读取完整正文。" };
    } else if (command === "knowledge:read") {
      assertNoEditFlags();
      if (opts.positional.length !== 1) throw new Error("用法：knowledge:read <文档id>。");
      result = { entry: storage.getKnowledgeDocument(opts.scope, ownerId, id!, scopedToken) };
    } else if (command === "knowledge:remember") {
      if (opts.revision !== undefined || opts.positional.length !== (opts.stdin ? 0 : 1)) throw new Error("用法：knowledge:remember <正文> 或 --stdin，可附 --scope、--title、--folder。");
      const content = opts.stdin ? await readKnowledgeStdin() : id!;
      if (legacy) result = { saved: true, entry: storage.rememberEmployeeKnowledge(legacy, content, token) };
      else result = { saved: true, ...storage.createKnowledgeDocument(opts.scope, ownerId, { content, title: opts.title, folder: opts.folder }, token) };
    } else if (command === "knowledge:update") {
      if (!access) throw new Error("旧会话不支持文档编辑，请新开一轮执行。");
      if (opts.revision === undefined || opts.positional.length !== (opts.stdin ? 1 : 2)) throw new Error("用法：knowledge:update <id> <正文> 或 --stdin，必须附 --revision <版本>。");
      const content = opts.stdin ? await readKnowledgeStdin() : text!;
      const previous = storage.getKnowledgeDocument(opts.scope, ownerId, id!, token);
      result = { saved: true, entry: storage.updateKnowledgeDocument(opts.scope, ownerId, id!, opts.revision,
        { content, title: opts.title ?? previous.title, folder: opts.folder ?? previous.folder }, token) };
    } else if (command === "knowledge:forget") {
      if (opts.stdin || opts.title !== undefined || opts.folder !== undefined || opts.positional.length !== 1) throw new Error("用法：knowledge:forget <id> --revision <读取的版本>。");
      if (legacy) result = { deleted: storage.forgetEmployeeKnowledge(legacy, id!, token) };
      else {
        if (opts.revision === undefined) throw new KnowledgeError("删除文档必须传入 --revision，请先读取并核对。");
        storage.deleteKnowledgeDocument(opts.scope, ownerId, id!, opts.revision, token);
        result = { deleted: true };
      }
    } else throw new Error("未知知识库操作。");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { storage.close(); }
}
