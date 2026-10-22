import type { Request } from "express";
import { DECISION_EXPERT_NAME } from "./decision-expert-identity.js";
import type { OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { ProcessManager } from "./process-manager.js";
import { WandStorage } from "./storage.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { ExecutionMode, ProcessEvent, SessionSnapshot, WandConfig } from "./types.js";

import { compactToolMessagesForTransport, windowMessagesForTransport } from "./message-truncator.js";
import { toSessionDetailDTO } from "./session-transport.js";

import { installedPiExtensions } from "./pi-extension-resources.js";
import { discoverPiResources } from "./pi-resource-catalog.js";
import { effectivePiSessionSettings, type PiSettingsControls, type PiSettingsResponse } from "./pi-session-settings.js";
import { type PiRecommendationRuntime } from "./server-pi-recommendation-routes.js";
import { SessionRegistry } from "./session-registry.js";
import { enrichStructuredMessages } from "./structured-client-protocol.js";
import { badRequest } from "./http-error.js";

import { SessionDirectoryTreeResponse, buildSessionDirectoryTree } from "./session-service.js";

/** Dependencies shared by every session route module (one typed object, no positional args). */
export interface SessionRouteDeps {
  processes: ProcessManager;
  structured: StructuredSessionManager;
  storage: WandStorage;
  defaultMode: ExecutionMode;
  config: WandConfig;
  sessions: SessionRegistry;
  onSessionCreated?: (cwd: string | undefined | null) => void;
  onCompletionViewed?: (event: ProcessEvent) => void;
  decisions?: PiRecommendationRuntime;
  free?: Pick<OpenRouterFreeModelsService, "resolveForCall">;
}

export interface SessionRouteContext extends SessionRouteDeps {
  wantsCompactTools: (req: Request) => boolean;
  sessionResponseDTO: (snapshot: SessionSnapshot, req: Request) => ReturnType<typeof toSessionDetailDTO>;
  currentDirectoryTree: () => SessionDirectoryTreeResponse;
  piSettingsResponse: (id: string) => Promise<PiSettingsResponse>;
  requirePiSession: (id: string) => void;
}

export function createSessionRouteContext(deps: SessionRouteDeps): SessionRouteContext {
  const { structured, storage, sessions, config, decisions } = deps;
  const wantsCompactTools = (req: Request): boolean =>
    req.get("X-Wand-Tool-Projection") === "compact" || req.query.compactTools === "1";

  const sessionResponseDTO = (snapshot: SessionSnapshot, req: Request) => {
    const enriched = sessions.transportMessages?.(snapshot.id, snapshot.messages ?? []) ?? enrichStructuredMessages(snapshot.messages ?? [], snapshot.id);
    const windowed = windowMessagesForTransport(
      wantsCompactTools(req) ? compactToolMessagesForTransport(enriched) : enriched,
      config.cardDefaults ?? {},
    );
    return toSessionDetailDTO(snapshot, {
      messages: windowed.messages,
      messageOffset: windowed.messageOffset,
      messageTotal: windowed.messageTotal,
    });
  };

  const currentDirectoryTree = (): SessionDirectoryTreeResponse => buildSessionDirectoryTree(
    sessions.listSlim(),
    storage.listSessionDirectoryNames(),
  );

  const piSettingsResponse = async (id: string): Promise<PiSettingsResponse> => {
    const { settings, resolution } = structured.getPiSettings(id);
    const snapshot = structured.get(id)!;
    const sdk = resolution.engine === "core";
    const sdkReader = sdk ? await (await import("./harness-engine.js")).loadPiCodingAgent() : undefined;
    const installed = await installedPiExtensions(config, snapshot.cwd, sdkReader);
    const archived = snapshot.archived;
    const modifiable = !archived;
    const goalAvailable = installed.some((item) => item.goal);
    const localDecisionAvailable = config.localDecision?.enabled === true || decisions?.status().enabled === true;
    const catalog = sdk ? { supported: false, reason: "Wand Agent 尚不支持 Skills / MCP 会话选择。", skills: [], mcpServers: [] }
      : (await discoverPiResources(config, snapshot.cwd)).catalog;
    const resourceCatalog = { ...catalog, supported: modifiable && !sdk && catalog.supported,
      reason: archived ? "请先恢复已归档的会话。" : sdk ? "Wand Agent 尚不支持 Skills / MCP 会话选择。" : catalog.reason };
    const controls: PiSettingsControls = {
      // 基础工具与 CodeMode 在两种引擎下都能表达（CLI 通过 --tools 白名单）。
      tools: modifiable,
      codemode: modifiable,
      codemodeOnly: modifiable && sdk,
      codemodeOverride: modifiable && !sdk,
      globalTools: modifiable,
      goalMode: modifiable && goalAvailable,
      localDecision: modifiable && localDecisionAvailable,
      autoCompaction: modifiable && sdk,
    };
    const status = decisions?.status();
    const recommendationAvailable = resourceCatalog.supported && settings.localDecision !== false
      && status?.enabled === true && status.supported && status.configured;
    const recommendationReason = !resourceCatalog.supported ? resourceCatalog.reason
      : settings.localDecision === false ? "本会话已关闭本地决策。"
      : !recommendationAvailable ? status && "notice" in status && typeof status.notice === "string" ? status.notice : `本地决策未启用或运行环境不可用；请配置「${DECISION_EXPERT_NAME}」调用链。` : "";
    return { recommendationAvailable, recommendationReason,
      autoResourcesAvailable: recommendationAvailable, autoResourcesReason: recommendationReason,
      autoCodemodeAvailable: recommendationAvailable, skillLocksAvailable: resourceCatalog.supported,
      ...(status?.hardware && typeof status.employeeId === "string" ? { decisionAdvisor: {
        notice: status.notice ?? null, employeeId: status.employeeId, hardware: status.hardware } } : {}),
      settings: effectivePiSessionSettings(settings, resolution.engine), engine: resolution.engine,
      available: sdk && modifiable, toolsAvailable: !sdk && modifiable,
      reason: archived ? "请先恢复已归档的会话。" : resolution.reason,
      goalAvailable, globalExtensions: [...new Set(installed.filter((item) => !item.goal).map((item) => item.name))],
      localDecisionAvailable, controls, resourceCatalog };
  };
  const requirePiSession = (id: string): void => {
    const owner = sessions.ownerOf(id);
    if (!owner) throw Object.assign(new Error("未找到该会话。"), { status: 404 });
    if (owner !== "structured" || structured.get(id)?.provider !== "pi") {
      throw badRequest("这些设置仅适用于 Pi 结构化会话，不会改变 PTY 或其他工具。");
    }
  };
  return {
    ...deps,
    wantsCompactTools,
    sessionResponseDTO,
    currentDirectoryTree,
    piSettingsResponse,
    requirePiSession,
  };
}
