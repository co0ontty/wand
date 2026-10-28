import type { Express } from "express";
import { parseExecutionMode, parseSessionCreationOrigin } from "./session-request.js";

import { isExecutionMode } from "./config.js";
import { defaultRoleForCli } from "./default-employee.js";
import { fallbackProviderModel, resolveExplicitOrFallbackModel, sessionEmployeeFields } from "./session-model.js";
import { CommandRequest, ExecutionMode, SessionProvider, SessionRunner, SessionSnapshot } from "./types.js";

import { resolveSessionCwd } from "./session-cwd.js";

import { asyncRoute } from "./express-async.js";
import { principalHasScope } from "./auth.js";
import { inferProviderFromCommand, providerCliCommand } from "./session-provider.js";
import { recordRecentPath } from "./recent-paths.js";
import { toSessionDetailDTO } from "./session-transport.js";
import { compactToolMessagesForTransport, windowMessagesForTransport } from "./message-truncator.js";
import { enrichStructuredMessages } from "./structured-client-protocol.js";
import { installedPiExtensions } from "./pi-extension-resources.js";
import { discoverPiResources, resolvePiResourceSettingsPatch } from "./pi-resource-catalog.js";
import { effectivePiSessionSettings, patchPiSessionSettings } from "./pi-session-settings.js";
import { isProviderSessionId } from "./resume-policy.js";
import { sendRouteError } from "./server-request.js";
import { isSessionProvider } from "./session-provider.js";
import { selectEmployeeCandidate } from "./silicon-employee-dispatch.js";
import { parseConversationExecutionPreference, withConversationExecutionPreference } from "./conversation-execution-preference.js";
import { projectCwdForSession, resolveWorkspaceIdForNewSession } from "./workspace-binding.js";
import { badRequest, surfaceDomainError } from "./http-error.js";

import type { SessionRouteContext } from "./server-session-context.js";
import { getInputDebugMeta, startResumedPtySession, restoreArchivedSession } from "./session-service.js";

/** Session creation, metadata/provider/model settings, resume, archive and deletion routes. */
export function registerSessionLifecycleRoutes(app: Express, ctx: SessionRouteContext): void {
  const {
    processes, structured, storage, defaultMode, config, sessions, onSessionCreated, decisions,
    wantsCompactTools, sessionResponseDTO, piSettingsResponse, requirePiSession,
  } = ctx;

  app.post("/api/sessions", asyncRoute(async (req, res) => {
    const body = req.body as CommandRequest & { kind?: unknown; prompt?: string; runner?: SessionRunner; engine?: string; employeeId?: unknown; teamId?: unknown; subject?: { type?: unknown }; overrideCli?: unknown; sessionSource?: unknown; automationId?: unknown };
    try {
      if (body.kind !== "structured" && body.kind !== "pty") throw badRequest("kind 必须是 structured 或 pty。");
      if (body.prompt !== undefined && typeof body.prompt !== "string") throw badRequest("prompt 必须是字符串。");
      if (body.initialInput !== undefined && typeof body.initialInput !== "string") throw badRequest("initialInput 必须是字符串。");
      const prompt = body.prompt?.trim();
      if (body.kind === "pty") {
        if (prompt !== undefined) throw badRequest("PTY 会话不接受结构化 prompt，请使用 initialInput。");
        if ((body.engine !== undefined && body.engine !== "cli") || body.runner !== undefined
          || body.employeeId !== undefined || body.teamId !== undefined
          || (body.subject !== undefined && body.subject?.type !== "cli")) {
          throw badRequest("PTY 不支持 SDK engine、runner 或员工/团队身份。");
        }
        if (body.provider !== undefined && !isSessionProvider(body.provider)) throw badRequest("请选择有效的执行工具。");
        const interactiveShell = body.shell === true;
        if (interactiveShell && (body.command !== undefined || body.provider !== undefined)) {
          throw badRequest("shell:true 不能同时指定 command 或 provider。");
        }
        if (!req.principal || !principalHasScope(req.principal, "admin")) {
          if (!interactiveShell) {
            const rawCommand = typeof body.command === "string" ? body.command.trim() : "";
            const provider = isSessionProvider(body.provider) ? body.provider : inferProviderFromCommand(rawCommand);
            const isProviderCli = !!provider && (!rawCommand || rawCommand === provider || rawCommand === providerCliCommand(provider));
            if (!isProviderCli) {
              res.status(403).json({ error: "当前连接只能启动已配置的 CLI 工具，不能执行自定义命令。", code: "forbidden" });
              return;
            }
          }
        }
        if (!interactiveShell && !body.command?.trim()) throw badRequest("请输入要执行的命令。");
        if (body.mode !== undefined && !isExecutionMode(body.mode)) throw badRequest(`无效执行模式: ${String(body.mode)}`);
        const initialInput = body.initialInput?.trim();
        const origin = parseSessionCreationOrigin(body, interactiveShell);
        const rawModel = typeof body.model === "string" ? body.model.trim() : "";
        const rawCommand = body.command?.trim() ?? "";
        const provider: SessionProvider | undefined = interactiveShell
          ? undefined
          : (isSessionProvider(body.provider) ? body.provider : inferProviderFromCommand(rawCommand) ?? "claude");
        const command = provider === "qoder" && rawCommand === "qoder" ? "qodercli" : rawCommand;
        const effectiveModel = provider ? rawModel || fallbackProviderModel(config, provider) : undefined;
        const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
        const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
        const sessionCwd = resolveSessionCwd(body.cwd, config.defaultCwd);
        const workspaceId = resolveWorkspaceIdForNewSession(storage, sessionCwd, body.workspaceId);
        const role = !interactiveShell && !body.systemPrompt?.trim() && origin.sessionSource === "interactive"
          && (isSessionProvider(body.provider) || inferProviderFromCommand(command))
          ? defaultRoleForCli(storage, provider) : null;
        const snapshot = await (interactiveShell
          ? processes.startShell(sessionCwd, body.mode ?? "default", {
              worktreeEnabled: body.worktreeEnabled === true, cols: reqCols, rows: reqRows, workspaceId,
              workspaceTaskId: body.workspaceTaskId, ...origin,
            })
          : processes.start(command, sessionCwd, body.mode ?? config.defaultMode, initialInput || undefined, {
              worktreeEnabled: body.worktreeEnabled === true, provider, model: effectiveModel, cols: reqCols, rows: reqRows,
              thinkingEffort: body.thinkingEffort ?? config.defaultThinkingEffort,
              systemPrompt: body.systemPrompt?.trim() || role?.prompt, ...sessionEmployeeFields(role),
              workspaceId, workspaceTaskId: body.workspaceTaskId, ...origin,
            }));
        recordRecentPath(storage, snapshot.cwd);
        const messages = enrichStructuredMessages(snapshot.messages ?? [], snapshot.id);
        const windowed = windowMessagesForTransport(
          wantsCompactTools(req) ? compactToolMessagesForTransport(messages) : messages,
          config.cardDefaults ?? {},
        );
        res.status(201).json(toSessionDetailDTO(snapshot, {
          messages: windowed.messages, messageOffset: windowed.messageOffset, messageTotal: windowed.messageTotal,
        }));
        return;
      }
      if (body.shell !== undefined || body.command !== undefined || body.initialInput !== undefined
        || body.kind !== "structured") {
        throw badRequest("结构化会话不接受 PTY 参数。");
      }
      if (body.engine !== undefined && body.engine !== "cli" && body.engine !== "sdk") throw badRequest("请选择有效的执行引擎。");
      if (body.teamId !== undefined || body.subject?.type === "team") {
        throw badRequest("AI 团队请通过团队开工入口创建群聊。");
      }
      if (body.subject?.type === "employee") throw badRequest("员工会话请传 employeeId。");
      const employeeId = body.employeeId === undefined ? "" : typeof body.employeeId === "string" ? body.employeeId.trim() : null;
      if (employeeId === null || (body.employeeId !== undefined && !employeeId)) {
        throw badRequest("employeeId 必须是员工 ID。");
      }
      if (employeeId && body.runner === "pty") {
        throw badRequest("硅基员工只支持结构化会话。");
      }
      const employee = employeeId ? storage.getSiliconEmployee(employeeId) : null;
      if (employeeId && (!employee || employee.archivedAt)) throw badRequest("硅基员工不存在或已归档。");
      const selectedEmployeeCandidate = employee ? selectEmployeeCandidate(employee) : null;
      const manualPreference = body.overrideCli === true ? parseConversationExecutionPreference({
        provider: body.provider, engine: body.engine, model: body.model || "default", thinkingEffort: body.thinkingEffort || "off",
      }) : undefined;
      const executionEmployee = employee && manualPreference ? withConversationExecutionPreference(employee, manualPreference) : employee;
      const employeeAgent = manualPreference && executionEmployee ? executionEmployee.agents[0] : selectedEmployeeCandidate?.agent;
      if (body.provider && !isSessionProvider(body.provider)) {
        res.status(400).json({ error: "结构化会话当前仅支持 Claude、Codex、OpenCode、Grok、Qoder 或 Pi provider。" });
        return;
      }
      const overrideCli = body.overrideCli === true;
      const rawProvider = typeof body.provider === "string" ? body.provider.trim() : "";
      const requestedProvider = overrideCli && isSessionProvider(rawProvider) ? rawProvider : null;
      const provider: SessionProvider = requestedProvider
        ?? employeeAgent?.provider
        ?? (isSessionProvider(body.provider) ? body.provider : config.defaultProvider ?? "claude");
      // 引擎是第二个维度：Pi CLI（cli）与 Wand Agent（sdk）都是 provider=pi，但执行方式不同。
      // 员工候选自己带引擎；只有直选 CLI（含员工面板里的「指定 CLI」）才接受请求里的 engine。
      const rawEngine = typeof body.engine === "string" ? body.engine.trim() : "";
      if (rawEngine && rawEngine !== "cli" && rawEngine !== "sdk") {
        res.status(400).json({ error: "请选择有效的执行引擎。" });
        return;
      }
      const requestedEngine: "cli" | "sdk" | undefined = employee && !requestedProvider
        ? employeeAgent?.engine ?? "cli"
        : rawEngine ? rawEngine as "cli" | "sdk" : undefined;
      if (requestedEngine === "sdk" && provider !== "pi") {
        res.status(400).json({ error: "Wand Agent 只支持 Pi 结构化会话。" });
        return;
      }
      const engineDecision = requestedEngine ? await structured.resolveNewSessionPiEngine(requestedEngine) : null;
      const rawModel = typeof body.model === "string" ? body.model.trim() : "";
      const origin = parseSessionCreationOrigin(body);
      // Explicit employees/custom role rules and internal automation retain their own role.
      const defaultEmployee = !employee && !body.systemPrompt?.trim()
        && origin.sessionSource === "interactive" ? defaultRoleForCli(storage, provider) : null;
      const role = employee ?? defaultEmployee;
      const cwd = resolveSessionCwd(body.cwd, config.defaultCwd);
      const snapshot = structured.createSession({
        cwd,
        mode: (requestedProvider && body.mode ? parseExecutionMode(body.mode, defaultMode) : null)
          ?? employeeAgent?.mode
          ?? parseExecutionMode(body.mode, defaultMode),
        provider,
        // Omit runner to let StructuredSessionManager apply the configured
        // Claude default; explicit values are validated against the provider.
        runner: employee && !requestedProvider ? undefined : body.runner,
        worktreeEnabled: body.worktreeEnabled === true,
        model: rawModel && rawModel !== "default"
          ? rawModel
          : (employeeAgent && !requestedProvider
              ? resolveExplicitOrFallbackModel(config, provider, employeeAgent.model)
              : rawModel || fallbackProviderModel(config, provider)),
        thinkingEffort: employeeAgent?.thinkingEffort ?? (typeof body.thinkingEffort === "string"
          ? (body.thinkingEffort as SessionSnapshot["thinkingEffort"])
          : config.defaultThinkingEffort),
        workspaceId: resolveWorkspaceIdForNewSession(storage, cwd, body.workspaceId),
        workspaceTaskId: body.workspaceTaskId,
        // 角色与规则走系统提示通道，不拼进 prompt（见 AGENTS.md「Session 输入契约」）。
        systemPrompt: role?.prompt ?? body.systemPrompt,
        ...sessionEmployeeFields(role),
        employeeCandidates: executionEmployee?.agents,
        employeeCandidateIndex: manualPreference ? 0 : selectedEmployeeCandidate?.index,
        ...(engineDecision ? { engine: engineDecision.engine } : {}),
        ...origin,
      });
      onSessionCreated?.(snapshot.cwd);
      if (prompt) {
        try {
          Promise.resolve(structured.sendMessage(snapshot.id, prompt, { source: origin.sessionSource === "interactive" ? "user" : "task" })).catch((error) => {
            console.error("[wand] Accepted structured prompt later failed", {
              sessionId: snapshot.id,
              error: getInputDebugMeta(error),
            });
          });
        } catch (error) {
          console.error("[wand] Accepted structured prompt later failed", {
            sessionId: snapshot.id,
            error: getInputDebugMeta(error),
          });
        }
      }
      res.status(201).json(sessionResponseDTO(structured.get(snapshot.id) ?? snapshot, req));
    } catch (error) {
      sendRouteError(res, surfaceDomainError(error, /Wand Agent|harness|core/i) ?? error, "无法启动结构化会话。");
    }
  }));

  app.put("/api/sessions/:id/quick-terminal", (req, res) => {
    try {
      res.json(sessionResponseDTO(sessions.claimQuickTerminal(req.params.id), req));
    } catch (error) {
      sendRouteError(res, error, "无法连接快捷终端。");
    }
  });

  app.post("/api/sessions/:id/directory", (req, res) => {
    const cwd = req.body?.cwd;
    if (typeof cwd !== "string" || !cwd.trim()) {
      res.status(400).json({ error: "请选择有效的运行目录。" });
      return;
    }
    const id = req.params.id;
    const owner = sessions.ownerOf(id);
    if (!owner) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (owner !== "structured") {
      res.status(400).json({ error: "只有新建空白结构化对话可以更换运行目录。" });
      return;
    }
    try {
      const updated = structured.setSessionDirectory(id, cwd);
      onSessionCreated?.(updated.cwd);
      res.json(sessionResponseDTO(updated, req));
    } catch (error) {
      sendRouteError(res, error, "切换运行目录失败。");
    }
  });

  app.post("/api/sessions/:id/employee", (req, res) => {
    const employeeId = req.body?.employeeId;
    if (typeof employeeId !== "string" || !employeeId.trim()) {
      res.status(400).json({ error: "请选择有效的员工身份。" });
      return;
    }
    const id = req.params.id;
    const owner = sessions.ownerOf(id);
    if (!owner) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (owner !== "structured") {
      res.status(400).json({ error: "只有新建空白结构化对话可以更换员工。" });
      return;
    }
    try {
      res.json(sessionResponseDTO(structured.setSessionEmployee(id, employeeId.trim()), req));
    } catch (error) {
      sendRouteError(res, error, "切换员工失败。");
    }
  });

  app.post("/api/sessions/:id/provider", asyncRoute(async (req, res) => {
    const provider = req.body?.provider;
    const engine = req.body?.engine;
    if (engine !== undefined && engine !== "cli" && engine !== "sdk") {
      res.status(400).json({ error: "执行引擎必须是 cli 或 sdk。" });
      return;
    }
    if (engine === "sdk" && provider !== "pi") {
      res.status(400).json({ error: "Wand Agent 只支持 Pi 结构化会话。" });
      return;
    }
    if (!isSessionProvider(provider)) {
      res.status(400).json({ error: "请选择有效的执行工具。" });
      return;
    }
    const id = req.params.id;
    const owner = sessions.ownerOf(id);
    if (!owner) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (owner !== "structured") {
      res.status(400).json({ error: "只有新建空白结构化对话可以更换工具。" });
      return;
    }
    try {
      if (engine === "sdk") await structured.resolveNewSessionPiEngine(engine);
      res.json(sessionResponseDTO(structured.setSessionProvider(id, provider, engine), req));
    } catch (error) {
      sendRouteError(res, error, "切换工具失败。");
    }
  }));

  app.get("/api/sessions/:id/pi-settings", asyncRoute(async (req, res) => {
    try {
      requirePiSession(req.params.id);
      res.set("Cache-Control", "no-store");
      res.json(await piSettingsResponse(req.params.id));
    } catch (error) { sendRouteError(res, error, "读取 Pi 设置失败。", (error as { status?: number }).status ?? 400); }
  }));

  app.patch("/api/sessions/:id/pi-settings", asyncRoute(async (req, res) => {
    try {
      const id = req.params.id;
      requirePiSession(id);
      const { settings } = structured.getPiSettings(id);
      const next = patchPiSessionSettings(settings, req.body);
      let patch = req.body;
      if (req.body.autoResources === true) {
        const capabilities = await piSettingsResponse(id);
        const runtime = decisions?.status();
        if (!capabilities.resourceCatalog?.supported || next.localDecision === false
          || !runtime?.enabled || !runtime.supported || !runtime.configured) {
          throw badRequest(next.localDecision === false ? "本会话已关闭本地决策。"
            : capabilities.autoResourcesReason || "自动选择暂不可用。");
        }
      }
      if (next.goalMode && !settings.goalMode) {
        const installed = await installedPiExtensions(config, structured.get(id)!.cwd);
        if (!installed.some((item) => item.goal)) throw badRequest("目标模式不可用：请先在 Pi 中安装并启用 pi-goal。");
      }
      if (req.body.resources !== undefined || req.body.lockedSkills !== undefined) {
        const inventory = await discoverPiResources(config, structured.get(id)!.cwd);
        // A lock-only patch must release from the latest selection after asynchronous discovery.
        patch = resolvePiResourceSettingsPatch(inventory, structured.getPiSettings(id).settings, patch);
      }
      structured.setPiSettings(id, patch);
      // 回复「实际生效」的设置（CLI 的 CodeMode 只归一到 off/on），不把存库原值当生效值展示。
      const saved = structured.getPiSettings(id);
      res.json({ settings: effectivePiSessionSettings(saved.settings, saved.resolution.engine) });
    } catch (error) {
      const domainError = surfaceDomainError(error, /^(Pi 设置必须是对象。|请选择有效的 Skills \/ MCP 列表。|资源选择不能包含路径、命令或其他设置。|资源选择必须是无重复的已安装资源 ID（每类最多64项）。|锁定技能必须是无重复的已安装 Skill ID（最多64项）。|CodeMode 请选择跟随 Pi、关闭、启用或仅 CodeMode。|CodeMode 必须是 off、on 或 only。|基础工具必须是无重复的 Pi 工具列表。|.+ 必须是是否启用（boolean）。|未知 Pi 设置：.+|Wand Agent 尚不支持此会话级设置；没有改用全局资源或 CodeMode 配置。|所选 Skill 已不存在或已被停用，请重新选择；没有改用其他 Skill。|所选 MCP 已不存在，请重新选择；没有连接其他 MCP。|.+需要原生 SDK；CLI 会话只能选择启用或关闭。|请先恢复已归档的会话。)$/) ?? error;
      sendRouteError(res, domainError, "保存 Pi 设置失败。", (error as { status?: number }).status ?? 400);
    }
  }));

  app.post("/api/sessions/:id/model", (req, res) => {
    const body = req.body as { model?: string | null };
    const rawModel = typeof body?.model === "string" ? body.model.trim() : null;
    const id = req.params.id;
    try {
      const updated = sessions.setSessionModel(id, rawModel);
      if (!updated) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      res.json(wantsCompactTools(req) ? sessionResponseDTO(updated, req) : updated);
    } catch (error) {
      sendRouteError(res, error, "切换模型失败。");
    }
  });

  // 思考深度切换：与 /model 路由对称。结构化会话立即影响下一条 prompt（CLI/SDK 各自接入
  // --effort / thinking budget），PTY 会话通过 /effort 更新当前 Claude 进程。

  app.post("/api/sessions/:id/thinking-effort", (req, res) => {
    const body = req.body as { thinkingEffort?: string | null };
    const raw = typeof body?.thinkingEffort === "string" ? body.thinkingEffort : null;
    const id = req.params.id;
    try {
      const updated = sessions.setSessionThinkingEffort(id, raw as SessionSnapshot["thinkingEffort"]);
      if (!updated) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      res.json(wantsCompactTools(req) ? sessionResponseDTO(updated, req) : updated);
    } catch (error) {
      sendRouteError(res, error, "切换思考深度失败。");
    }
  });

  // 执行模式切换：与 /model、/thinking-effort 路由对称。结构化会话立即影响下一条
  // prompt（权限策略 / 系统提示 / CLI flag 都按 session.mode 逐轮重新派生）；PTY 会话
  // 仅更新 wand 自身的权限自动放行判定，已启动的 claude 进程命令行 flag 不变。codex 锁 full-access。

  app.post("/api/sessions/:id/mode", (req, res) => {
    const body = req.body as { mode?: string };
    const raw = typeof body?.mode === "string" ? body.mode.trim() : "";
    if (!raw) {
      res.status(400).json({ error: "缺少 mode。" });
      return;
    }
    if (!isExecutionMode(raw)) {
      res.status(400).json({ error: `无效执行模式: ${raw}` });
      return;
    }
    const mode = raw;
    const id = req.params.id;
    try {
      const snapshot = sessions.get(id);
      if (!snapshot) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      const effective = (snapshot.provider ?? "claude") === "codex" ? "full-access" : mode;
      const updated = sessions.setSessionMode(id, effective);
      res.json(updated && wantsCompactTools(req) ? sessionResponseDTO(updated, req) : updated);
    } catch (error) {
      sendRouteError(res, error, "切换模式失败。");
    }
  });

  app.post("/api/sessions/batch-delete", (req, res) => {
    const sessionIds = Array.isArray(req.body?.sessionIds)
      ? req.body.sessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];

    if (sessionIds.length === 0) {
      res.status(400).json({ error: "至少提供一个会话 ID。" });
      return;
    }

    let deleted = 0;
    const failed: string[] = [];

    for (const sessionId of sessionIds) {
      try {
        sessions.deleteWithProviderHistory(sessionId);
        deleted += 1;
      } catch {
        failed.push(sessionId);
      }
    }

    if (deleted === 0 && failed.length > 0) {
      res.status(400).json({ error: "无法批量删除会话。", failed });
      return;
    }

    res.json({ ok: true, deleted, failed });
  });

  app.post("/api/sessions/:id/resume", asyncRoute(async (req, res) => {
    const sessionId = req.params.id;
    const body = req.body as { mode?: ExecutionMode; view?: "chat" | "terminal"; cols?: number; rows?: number };
    try {
      const existingSession = processes.get(sessionId) || storage.getSession(sessionId);
      if (!existingSession) {
        res.status(404).json({ error: "会话不存在。" });
        return;
      }
      if ((existingSession.sessionKind ?? "pty") !== "pty") {
        res.status(400).json({ error: "结构化会话不支持 PTY resume。" });
        return;
      }
      const newSnapshot = await startResumedPtySession(processes, storage, existingSession, sessionId, defaultMode, body);
      res.status(201).json(sessionResponseDTO(newSnapshot, req));
    } catch (error) {
      sendRouteError(res, error, "无法恢复会话。");
    }
  }));

  app.post("/api/claude-sessions/:claudeSessionId/resume", asyncRoute(async (req, res) => {
    const claudeSessionId = String(req.params.claudeSessionId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string; cols?: number; rows?: number; sessionSource?: unknown; automationId?: unknown };
    try {
      const requestedOrigin = body.sessionSource !== undefined || body.automationId !== undefined
        ? parseSessionCreationOrigin(body)
        : null;
      if (!isProviderSessionId(claudeSessionId)) {
        res.status(400).json({ error: "Claude 会话 ID 必须是有效的 UUID。" });
        return;
      }
      const existingSession = storage.getLatestSessionByClaudeSessionId(claudeSessionId);
      if (existingSession) {
        if (existingSession.provider && existingSession.provider !== "claude") {
          res.status(400).json({ error: "只有 Claude provider 支持按 Claude Session ID 恢复。" });
          return;
        }
        const command = existingSession.command.trim();
        if ((existingSession.sessionKind ?? "pty") !== "pty") {
          res.status(400).json({ error: "结构化会话不支持按 Claude Session ID 恢复。" });
          return;
        }
        if (!/^claude\b/.test(command)) {
          res.status(400).json({ error: "只有 Claude 命令支持按 Claude Session ID 恢复。" });
          return;
        }
        if (!existingSession.cwd || !processes.hasClaudeSessionFile(existingSession.cwd, claudeSessionId)) {
          res.status(400).json({ error: "对应的 Claude 历史会话文件不存在，无法恢复。" });
          return;
        }
        const newMode = parseExecutionMode(body.mode, parseExecutionMode(existingSession.mode, defaultMode));
        // Do not reuse the persisted shell command here. It may contain flags or
        // shell operators and must never become part of a resume command.
        const resumeCommand = `claude --resume ${claudeSessionId}`;
        const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
        const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
        const newSnapshot = await processes.start(resumeCommand, existingSession.cwd, newMode, undefined, {
          reuseId: existingSession.id,
          cols: reqCols,
          rows: reqRows,
          systemPrompt: existingSession.systemPrompt ?? undefined,
          workspaceId: existingSession.workspaceId
            ?? resolveWorkspaceIdForNewSession(storage, projectCwdForSession(existingSession) || existingSession.cwd),
          workspaceTaskId: existingSession.workspaceTaskId,
          ...(requestedOrigin ?? {}),
        });
        res.status(201).json({ resumedClaudeSessionId: claudeSessionId, ...sessionResponseDTO(newSnapshot, req) });
      } else {
        const cwd = body.cwd?.trim();
        if (!cwd) {
          res.status(400).json({ error: "未找到对应的会话记录，请提供工作目录 (cwd)。" });
          return;
        }
        const newMode = parseExecutionMode(body.mode, defaultMode);
        const resumeCommand = `claude --resume ${claudeSessionId}`;
        const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
        const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
        const newSnapshot = await processes.start(resumeCommand, cwd, newMode, undefined, {
          cols: reqCols,
          rows: reqRows,
          workspaceId: resolveWorkspaceIdForNewSession(storage, cwd),
          ...(requestedOrigin ?? {}),
        });
        res.status(201).json({ resumedClaudeSessionId: claudeSessionId, ...sessionResponseDTO(newSnapshot, req) });
      }
    } catch (error) {
      sendRouteError(res, error, "无法按 Claude 会话 ID 恢复会话。");
    }
  }));

  app.post("/api/sessions/:id/archive", (req, res) => {
    try {
      const updated = sessions.setArchived(req.params.id, true);
      if (!updated) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      res.json(sessionResponseDTO(updated, req));
    } catch (error) {
      sendRouteError(res, error, "无法归档会话。", 409);
    }
  });

  app.post("/api/sessions/:id/unarchive", asyncRoute(async (req, res) => {
    try {
      const updated = await restoreArchivedSession(sessions, processes, storage, req.params.id, defaultMode);
      if (!updated) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      res.json(sessionResponseDTO(updated, req));
    } catch (error) {
      sendRouteError(res, error, "无法恢复会话。");
    }
  }));

  // 批量归档 / 恢复：与 /api/sessions/batch-delete 对称，返回失败项让客户端保留选择。

  app.post("/api/sessions/batch-archive", asyncRoute(async (req, res) => {
    const body = req.body as { sessionIds?: unknown; archived?: unknown } | null | undefined;
    const ids: string[] = Array.isArray(body?.sessionIds)
      ? body!.sessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (ids.length === 0) {
      res.status(400).json({ error: "至少提供一个会话 ID。" });
      return;
    }
    const archived = body?.archived !== false;
    const failed: string[] = [];
    let changed = 0;
    for (const id of ids) {
      try {
        const updated = archived
          ? sessions.setArchived(id, true)
          : await restoreArchivedSession(sessions, processes, storage, id, defaultMode);
        if (updated) changed += 1;
        else failed.push(id);
      } catch {
        failed.push(id);
      }
    }
    res.json({ ok: true, archived: changed, ...(failed.length > 0 ? { failed } : {}) });
  }));

  app.delete("/api/sessions/:id", (req, res) => {
    try {
      sessions.deleteWithProviderHistory(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      sendRouteError(res, error, "无法删除会话。");
    }
  });
}
