import { createPiExtensionResources } from "./pi-extension-resources.js";
import { PI_BUILTIN_TOOLS, type PiSessionSettings } from "./pi-session-settings.js";
import type { HarnessExtensionState, SessionSnapshot, WandConfig } from "./types.js";
import type { loadPiAi, loadPiCodingAgent } from "./harness-engine.js";
import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentSession, ExtensionRunner, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const MAX_EXTENSION_STATE_BYTES = 128 * 1024;
const MAX_EXTENSION_ENTRIES = 128;

export function parseHarnessExtensionState(raw: unknown): HarnessExtensionState | undefined {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as HarnessExtensionState).entries)) return undefined;
  const entries = (raw as HarnessExtensionState).entries;
  if (entries.length > MAX_EXTENSION_ENTRIES || Buffer.byteLength(JSON.stringify(entries)) > MAX_EXTENSION_STATE_BYTES) return undefined;
  if (!entries.every((entry) => entry && typeof entry.customType === "string" && entry.customType.length <= 200
    && (entry.type === "custom" || (entry.type === "custom_message" && typeof entry.content === "string" && typeof entry.display === "boolean")))) return undefined;
  return { entries };
}

/** Keep native snapshots/store data bounded, without another copy of Wand's ordinary messages. */
function captureExtensionState(manager: SessionManager, prior: HarnessExtensionState | undefined): HarnessExtensionState {
  const entries: HarnessExtensionState["entries"] = [];
  const store: Record<string, unknown> = Object.create(null);
  for (const entry of manager.getBranch()) {
    if (entry.type === "custom") {
      if (entry.customType === "codemode-store") {
        const data = entry.data as { set?: Record<string, unknown>; delete?: string[] } | undefined;
        Object.assign(store, data?.set ?? {});
        for (const key of data?.delete ?? []) delete store[key];
        continue;
      }
      if (entry.customType === "pi-goal") {
        const index = entries.findIndex((item) => item.type === "custom" && item.customType === entry.customType);
        if (index >= 0) entries.splice(index, 1);
      }
      entries.push({ type: "custom", customType: entry.customType, data: entry.data });
    } else if (entry.type === "custom_message") {
      // Goal events are snapshots: only the newest directive should survive into the next turn.
      if (entry.customType === "pi-goal-event") {
        const index = entries.findIndex((item) => item.type === "custom_message" && item.customType === entry.customType);
        if (index >= 0) entries.splice(index, 1);
      }
      const content = typeof entry.content === "string" ? entry.content : entry.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      entries.push({ type: "custom_message", customType: entry.customType, content, display: entry.display, details: entry.details });
    }
  }
  if (Object.keys(store).length) entries.push({ type: "custom", customType: "codemode-store", data: { set: store, delete: [] } });
  // Disabled custom messages were intentionally not exposed to the agent, but are not deleted.
  for (const entry of prior?.entries ?? []) {
    if (entry.type === "custom_message" && !entries.some((item) => item.customType === entry.customType)) entries.push(entry);
  }
  const state = parseHarnessExtensionState({ entries });
  if (!state) throw new Error("Pi 扩展状态超出保存上限（128 条 / 128 KiB）；没有截断或伪造已保存状态。");
  return state;
}

export interface CoreExtensionHost {
  session: AgentSession;
  capture(): HarnessExtensionState;
  interrupt(): void;
  close(): Promise<void>;
}

export async function createCoreExtensionHost(options: {
  pi: Awaited<ReturnType<typeof loadPiCodingAgent>>;
  ai: Awaited<ReturnType<typeof loadPiAi>>;
  config: WandConfig;
  target: SessionSnapshot;
  settings: PiSessionSettings;
  systemPrompt: string;
  agent: Agent;
  messages: AgentMessage[];
  tools: AgentTool[];
  runtime: ModelRuntime | null;
  /** Stream authentication is already owned by the injected stream / zero-price model allocator. */
  externalStreamAuth: boolean;
  onNotice(text: string): void;
}): Promise<CoreExtensionHost> {
  const { pi, target, settings, agent } = options;
  const resources = await createPiExtensionResources(pi, options.config, target.cwd, settings, options.systemPrompt);
  const manager = pi.SessionManager.inMemory(target.cwd);
  for (const entry of target.harnessExtensionState?.entries ?? []) {
    if (entry.type === "custom") manager.appendCustomEntry(entry.customType, entry.data);
    else if (entry.customType.startsWith("pi-goal") ? settings.goalMode : settings.globalTools) {
      manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    }
  }
  for (const message of options.messages) manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
  let runtime = options.runtime ?? await pi.ModelRuntime.create({
    credentials: new options.ai.InMemoryCredentialStore(), modelsStore: new options.ai.InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  if (options.externalStreamAuth) {
    // Per-session facade, never mutate the shared auth runtime or write synthetic credentials.
    const provider = agent.state.model.provider;
    runtime = new Proxy(runtime, { get(base, key) {
      if (key === "hasConfiguredAuth") return (id: string) => id === provider || base.hasConfiguredAuth(id);
      const value = Reflect.get(base, key);
      return typeof value === "function" ? value.bind(base) : value;
    } });
  }
  const runnerRef: { current?: ExtensionRunner } = {};
  const session = new pi.AgentSession({
    agent, cwd: target.cwd, sessionManager: manager, modelRuntime: runtime, resourceLoader: resources,
    // Wand owns compaction, queues, model choice and history; the SDK owns only this round's extensions.
    settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }),
    baseToolsOverride: Object.fromEntries(options.tools.map((tool) => [tool.name, tool])),
    initialActiveToolNames: [...options.tools.map((tool) => tool.name), ...(settings.codemode !== "off" ? ["codemode"] : [])],
    excludedToolNames: [...PI_BUILTIN_TOOLS.filter((name) => !settings.tools.includes(name)),
      ...(!settings.localDecision ? ["decision_evaluate"] : []),
      ...(settings.codemode === "off" ? ["codemode"] : []),
      ...(!settings.goalMode ? ["create_goal", "get_goal", "update_goal"] : [])],
    extensionRunnerRef: runnerRef,
  });
  try {
    // Keep headless dialogs conservative. Notifications still reach the caller instead of disappearing.
    const ui = runnerRef.current!.getUIContext();
    await session.bindExtensions({ mode: "print", uiContext: { ...ui, notify: options.onNotice },
      onError: (error) => { options.onNotice(`Pi 扩展错误：${error.error}`); },
      abortHandler: () => agent.abort(), shutdownHandler: () => agent.abort() });
  } catch (error) {
    session.dispose();
    throw error;
  }
  return { session,
    capture: () => captureExtensionState(manager, target.harnessExtensionState),
    interrupt: () => {
      // pi-goal continues on agent_end, even after abort. Pause its native state BEFORE aborting,
      // through the real command handler (never dispatch an unknown command to the model).
      if (settings.goalMode) {
        const runner = runnerRef.current;
        const goal = runner?.getCommand("goal");
        if (goal && runner) {
          void Promise.resolve(goal.handler("pause", runner.createCommandContext())).catch((error: unknown) => {
            options.onNotice(error instanceof Error ? error.message : "暂停目标失败。");
          });
        }
      }
      session.clearQueue();
      // The SDK's abort flag also prevents agent_end/before_settle hooks from restarting the loop.
      void session.abort().catch((error: unknown) => {
        options.onNotice(error instanceof Error ? error.message : "停止 Pi 扩展失败。");
      });
    },
    close: async () => {
      try { await runnerRef.current?.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); }
    },
  };
}
