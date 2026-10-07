/** Explicit CLI extension: replaces built-in MCP discovery without changing the user's agent directory. */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type ExtensionAPI, type McpExtensionOptions } from "@earendil-works/pi-coding-agent";

interface SelectionPolicy {
  agentDir: string;
  mcpServers?: string[];
  codemodeOverride?: "off" | "on" | "only";
}
type McpConfig = ReturnType<NonNullable<McpExtensionOptions["loadConfig"]>>;

export default async function wandResourceSelection(pi: ExtensionAPI): Promise<void> {
  const policyFile = process.env.WAND_PI_RESOURCE_POLICY;
  if (!policyFile) throw new Error("Wand 资源选择缺少本轮策略。");
  const policy = JSON.parse(readFileSync(policyFile, "utf8")) as SelectionPolicy;
  // Entries were validated by Pi's parser immediately before spawning. Read only this user's file;
  // do not replace the agent directory or discover trusted-project/extension servers implicitly.
  const allowed = new Set(policy.mcpServers ?? []);
  const scoped = new Proxy(pi, { get(target, key) {
    // Extensions may register servers too. They are not the file-configured entries the user selected.
    if (key === "getMcpServers") return () => [];
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  if (policy.mcpServers) createMcpExtension({
    loadConfig: (): McpConfig => {
      if (!allowed.size) return { servers: [], errors: [] };
      try {
        const source = join(policy.agentDir, "mcp.json");
        const raw = JSON.parse(readFileSync(source, "utf8"));
        const servers = policy.mcpServers!.map((name) => {
          const config = raw.mcpServers?.[name];
          if (!config) throw new Error("MCP 已移除");
          return { name, source, scope: "global" as const, config: { ...config, enabled: true } };
        });
        return { servers, errors: [], autoEnableCodemode: policy.codemodeOverride !== "off" && raw.autoEnableCodemode !== false };
      } catch {
        return { servers: [], errors: ["所选 MCP 配置无法读取，没有连接其他服务器。"] };
      }
    },
    updateConfig: () => { throw new Error("请通过 Wand 输入框中的 Skills / MCP 设置修改本会话选择。"); },
  })(scoped);
  if (policy.codemodeOverride) {
    // This explicit factory replaces the CLI builtin and can express `only` without modifying
    // settings.json. Active-tool changes preserve every common tool and selected MCP connection.
    const codemodeApi = policy.codemodeOverride === "off" ? new Proxy(pi, { get(target, key) {
      if (key === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) =>
        target.registerTool({ ...definition, exposure: "hidden" });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }) : pi;
    createCodemodeExtension({ mode: policy.codemodeOverride === "only" ? "only" : "on" })(codemodeApi);
    // MCP tools with indirect exposure still need an entrance when CodeMode is explicitly off.
    const searchInstead = policy.codemodeOverride === "off" && !!policy.mcpServers?.length;
    if (searchInstead) createToolSearchExtension()(pi);
    const apply = (): void => {
      const other = pi.getActiveTools().filter((name) => name !== "codemode");
      pi.setActiveTools(policy.codemodeOverride === "off"
        ? searchInstead ? [...other, "tool_search"] : other : [...other, "codemode"]);
    };
    pi.on("session_start", apply);
    pi.on("before_agent_start", apply);
    pi.on("tool_call", (event) => {
      if (event.toolName === "codemode" && policy.codemodeOverride === "off") {
        return { block: true, reason: "本会话已关闭 CodeMode，请在输入框设置中启用。" };
      }
    });
  }
  pi.on("session_shutdown", () => {
    // The CLI outlives web restarts: cleanup belongs to the child, not only its original web owner.
    rmSync(dirname(policyFile), { recursive: true, force: true });
  });
}
