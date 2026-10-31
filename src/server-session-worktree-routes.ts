import type { Express } from "express";

import { SessionSnapshot } from "./types.js";

import {
  generateCommitMessageOnly,
  getGitStatusAsync,
  QuickCommitError,
  runPush,
  runQuickCommitWithFallback,
  runTagHead,
} from "./git-quick-commit.js";
import { checkSessionWorktreeMergeabilityAsync, cleanupSessionWorktreeAsync, mergeSessionWorktreeAsync } from "./git-worktree.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { listGitWorktrees, mergeAllWorktreesAndPush, withGitRepositoryOperation } from "./git-worktree-batch.js";

import { getErrorMessage } from "./error-utils.js";
import { asyncRoute } from "./express-async.js";
import { buildIterationCommitContext, COMMIT_CONTEXT_MODE_PREF_KEY, isCommitContextMode } from "./iteration-log.js";
import { sendRouteError } from "./server-request.js";

import type { SessionRouteContext } from "./server-session-context.js";
import { commitModeForRead, iterationCommitInput, commitMessageFromIteration, requireWorktreeSession, saveWorktreeMergeState, getWorktreeMergeResponseStatus, getWorktreeMergePayload, canMergeSession, isMergeActionAllowed, getInputDebugMeta } from "./session-service.js";
import { selectEmployeeCandidate } from "./silicon-employee-dispatch.js";
import { resolveExplicitOrFallbackModel } from "./session-model.js";

/** Worktree merge/cleanup, git status/commit/push and iteration context routes. */
export function registerSessionWorktreeRoutes(app: Express, ctx: SessionRouteContext): void {
  const {
    storage, config, sessions, free, structured, onSessionCreated,
    wantsCompactTools, sessionResponseDTO,
  } = ctx;

  app.post("/api/sessions/:id/worktree/merge/check", asyncRoute(async (req, res) => {
    try {
      const current = requireWorktreeSession(sessions.getLatest(req.params.id));
      if (!isMergeActionAllowed(current)) {
        res.status(409).json({ error: "会话仍在运行，请结束后再合并。", errorCode: "SESSION_STILL_RUNNING" });
        return;
      }
      const checking = saveWorktreeMergeState(sessions, current, "checking", {
        ...(current.worktreeMergeInfo ?? null),
        targetBranch: current.worktreeMergeInfo?.targetBranch,
        lastError: undefined,
        conflict: false,
      });
      const result = await checkSessionWorktreeMergeabilityAsync({
        worktree: checking.worktree as NonNullable<SessionSnapshot["worktree"]>,
        targetBranch: current.worktreeMergeInfo?.targetBranch,
      });
      const nextStatus: SessionSnapshot["worktreeMergeStatus"] = result.ok ? "ready" : "failed";
      const updated = saveWorktreeMergeState(sessions, checking, nextStatus, {
        targetBranch: result.targetBranch,
        conflict: result.hasConflicts,
        lastError: result.ok ? undefined : result.reason,
      });
      res.json({ session: wantsCompactTools(req) ? sessionResponseDTO(updated, req) : updated, result });
    } catch (error) {
      res.status(getWorktreeMergeResponseStatus(error)).json(getWorktreeMergePayload(error, "无法检查 worktree 合并状态。"));
    }
  }));

  app.post("/api/sessions/:id/worktree/merge", asyncRoute(async (req, res) => {
    try {
      const current = requireWorktreeSession(sessions.getLatest(req.params.id));
      if (!isMergeActionAllowed(current)) {
        res.status(409).json({ error: "会话仍在运行，请结束后再合并。", errorCode: "SESSION_STILL_RUNNING" });
        return;
      }
      const merging = saveWorktreeMergeState(sessions, current, "merging", {
        ...(current.worktreeMergeInfo ?? null),
        lastError: undefined,
        conflict: false,
      });
      const result = await withGitRepositoryOperation(merging.worktree!.repoRoot ?? merging.cwd!, () => mergeSessionWorktreeAsync({
        worktree: merging.worktree as NonNullable<SessionSnapshot["worktree"]>,
        targetBranch: current.worktreeMergeInfo?.targetBranch,
      }));
      const updated = saveWorktreeMergeState(sessions, merging, "merged", {
        targetBranch: result.targetBranch,
        mergedAt: result.mergedAt,
        mergeCommit: result.mergeCommit,
        cleanupDone: result.cleanupDone,
        lastError: undefined,
        conflict: false,
      });
      res.json({ session: wantsCompactTools(req) ? sessionResponseDTO(updated, req) : updated, result });
    } catch (error) {
      const current = sessions.getLatest(req.params.id);
      if (current && canMergeSession(current)) {
        const payload = getWorktreeMergePayload(error, "无法合并 worktree。") as { error: string; errorCode: string | null; result: Partial<import("./types.js").WorktreeMergeResult> | null };
        saveWorktreeMergeState(sessions, current, "failed", {
          ...(current.worktreeMergeInfo ?? null),
          targetBranch: payload.result?.targetBranch ?? current.worktreeMergeInfo?.targetBranch,
          mergedAt: payload.result?.mergedAt,
          mergeCommit: payload.result?.mergeCommit,
          cleanupDone: payload.result?.cleanupDone,
          lastError: payload.error,
          conflict: payload.result?.conflict === true,
        });
      }
      res.status(getWorktreeMergeResponseStatus(error)).json(getWorktreeMergePayload(error, "无法合并 worktree。"));
    }
  }));

  app.get("/api/sessions/:id/git-status", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.json({ isGit: false });
      return;
    }
    try {
      const status = await getGitStatusAsync(snapshot.cwd);
      const worktreeCount = status.isGit ? Math.max(0, (await listGitWorktrees(snapshot.cwd)).length - 1) : 0;
      res.json({ ...status, worktreeCount });
    } catch (error) {
      res.json({ isGit: false, error: getErrorMessage(error, "无法读取 git 状态。") });
    }
  }));

  app.post("/api/sessions/:id/git/merge-worktrees", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) { res.status(404).json({ error: "未找到该会话。" }); return; }
    if (!snapshot.cwd) { res.status(400).json({ error: "会话没有工作目录。" }); return; }
    const { expectedBranch, expectedHead } = req.body ?? {};
    if (typeof expectedBranch !== "string" || !expectedBranch.trim()
      || typeof expectedHead !== "string" || !/^[a-f0-9]{40,64}$/.test(expectedHead)) {
      res.status(400).json({ error: "请先刷新 Git 状态，确认当前分支与提交。" });
      return;
    }
    try {
      res.json(await mergeAllWorktreesAndPush({ cwd: snapshot.cwd, expectedBranch, expectedHead }));
    } catch (error) {
      sendRouteError(res, error, "无法合并 Worktree。");
    }
  }));

  app.post("/api/sessions/:id/quick-commit", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。", errorCode: "NO_CWD" });
      return;
    }
    const body = (req.body ?? {}) as {
      autoMessage?: boolean; customMessage?: string; tag?: string; autoTag?: boolean; push?: boolean;
      submodule?: boolean; mode?: unknown; entryIds?: unknown; includeDiff?: boolean;
      archiveRelatedTasks?: boolean;
      workspaceTaskId?: unknown;
    };
    try {
      const ai = resolveSystemAiContext(snapshot, config, storage.getSystemSiliconEmployee(), free, { storage });
      // 自动 message + 迭代模式：拿本轮提示词当输入；提交成功后标记已用掉。
      const context = await iterationCommitInput(storage, snapshot, body);
      const result = await withGitRepositoryOperation(snapshot.cwd, () => runQuickCommitWithFallback({
        cwd: snapshot.cwd,
        language: config.language ?? "",
        ...ai,
        autoMessage: body.autoMessage !== false,
        customMessage: typeof body.customMessage === "string" ? body.customMessage : undefined,
        tag: typeof body.tag === "string" ? body.tag : undefined,
        autoTag: !!body.autoTag,
        push: !!body.push,
        submodule: !!body.submodule,
        iterationDigest: commitMessageFromIteration(body) ? context.digest : "",
        includeDiff: !!body.includeDiff,
      }));
      const consumed = result.ok && result.commit?.hash && context.entryIds.length > 0
        ? storage.markIterationPromptsConsumed(context.entryIds, result.commit.hash)
        : 0;
      res.json({
        ...result,
        // Compatibility for older clients: Git never changes task/session lifecycle.
        archivedTaskIds: [],
        archivedSessionIds: [],
        commitContext: {
          source: commitMessageFromIteration(body) && context.digest ? "iteration" : "diff",
          entryIds: context.entryIds,
          iteration: context.iteration,
        },
        iterationEntriesConsumed: consumed,
      });
    } catch (error) {
      if (error instanceof QuickCommitError) {
        const status = error.code === "NOTHING_TO_COMMIT" || error.code === "TAG_EXISTS" ? 409 : 400;
        res.status(status).json({ error: error.message, errorCode: error.code });
        return;
      }
      sendRouteError(res, error, "快捷提交失败。");
    }
  }));

  // 本轮迭代的提示词清单：快捷提交面板默认勾选「上次提交以来」的那些，
  // 也可以往回勾已提交过的历史，或者整套切成读 diff。

  app.get("/api/sessions/:id/iteration-context", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    const milestoneId = typeof req.query.milestoneId === "string" ? req.query.milestoneId : null;
    try {
      const context = await buildIterationCommitContext(storage, { session: snapshot, milestoneId });
      res.json({ ...context, mode: commitModeForRead(storage, req.query.mode) });
    } catch (error) {
      sendRouteError(res, error, "无法读取本轮变更。");
    }
  }));

  // 记住用户选的模式（只存偏好，不碰仓库）。

  app.post("/api/sessions/:id/iteration-context", (req, res) => {
    if (!sessions.getLatest(req.params.id)) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    const mode = (req.body ?? {}).mode;
    if (!isCommitContextMode(mode)) {
      res.status(400).json({ error: "无效的提交输入模式。" });
      return;
    }
    storage.setPreference(COMMIT_CONTEXT_MODE_PREF_KEY, mode);
    res.json({ ok: true, mode });
  });

  app.post("/api/sessions/:id/generate-commit-message", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。" });
      return;
    }
    const body = (req.body ?? {}) as { mode?: unknown; entryIds?: unknown; includeDiff?: boolean };
    try {
      const ai = resolveSystemAiContext(snapshot, config, storage.getSystemSiliconEmployee(), free, { storage });
      const context = await iterationCommitInput(storage, snapshot, body);
      const result = await generateCommitMessageOnly(snapshot.cwd, config.language ?? "", {
        ...ai,
      }, {
        iterationDigest: context.digest,
        includeDiff: !!body.includeDiff,
      });
      res.json({
        ...result,
        commitContext: {
          source: context.digest ? "iteration" : "diff",
          entryIds: context.entryIds,
          iteration: context.iteration,
        },
      });
    } catch (error) {
      if (error instanceof QuickCommitError) {
        res.status(400).json({ error: error.message, errorCode: error.code });
        return;
      }
      sendRouteError(res, error, "生成 commit message 失败。");
    }
  }));

  app.post("/api/sessions/:id/git/tag-head", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。", errorCode: "NO_CWD" });
      return;
    }
    const body = (req.body ?? {}) as { tag?: string; autoTag?: boolean; push?: boolean };
    try {
      const ai = resolveSystemAiContext(snapshot, config, storage.getSystemSiliconEmployee(), free, { storage });
      const result = await withGitRepositoryOperation(snapshot.cwd, () => runTagHead({
        cwd: snapshot.cwd,
        language: config.language ?? "",
        ...ai,
        tag: typeof body.tag === "string" ? body.tag : undefined,
        autoTag: !!body.autoTag,
        push: !!body.push,
      }));
      res.json(result);
    } catch (error) {
      if (error instanceof QuickCommitError) {
        const status = error.code === "TAG_EXISTS" ? 409 : 400;
        res.status(status).json({ error: error.message, errorCode: error.code });
        return;
      }
      sendRouteError(res, error, "打 tag 失败。");
    }
  }));

  app.post("/api/sessions/:id/git/push", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。", errorCode: "NO_CWD" });
      return;
    }
    const body = (req.body ?? {}) as { pushCommits?: boolean; pushTags?: boolean; submodule?: boolean; tag?: string };
    try {
      const result = await withGitRepositoryOperation(snapshot.cwd, () => runPush({
        cwd: snapshot.cwd,
        pushCommits: body.pushCommits !== false,
        pushTags: !!body.pushTags,
        submodule: !!body.submodule,
        tagName: typeof body.tag === "string" ? body.tag : undefined,
      }));
      res.json(result);
    } catch (error) {
      if (error instanceof QuickCommitError) {
        res.status(400).json({ error: error.message, errorCode: error.code });
        return;
      }
      sendRouteError(res, error, "推送失败。");
    }
  }));

  app.post("/api/sessions/:id/worktree/cleanup", asyncRoute(async (req, res) => {
    try {
      const current = requireWorktreeSession(sessions.getLatest(req.params.id));
      if (current.worktreeMergeStatus !== "merged" || current.worktreeMergeInfo?.cleanupDone !== false) {
        res.status(400).json({ error: "当前 worktree 无需补偿清理。", errorCode: "WORKTREE_CLEANUP_NOT_NEEDED" });
        return;
      }
      await withGitRepositoryOperation(current.worktree!.repoRoot ?? current.cwd!, () => cleanupSessionWorktreeAsync({ worktree: current.worktree as NonNullable<SessionSnapshot["worktree"]> }));
      const updated = saveWorktreeMergeState(sessions, current, "merged", {
        ...(current.worktreeMergeInfo ?? null),
        cleanupDone: true,
        lastError: undefined,
        conflict: false,
      });
      res.json({ session: wantsCompactTools(req) ? sessionResponseDTO(updated, req) : updated, ok: true });
    } catch (error) {
      res.status(getWorktreeMergeResponseStatus(error)).json(getWorktreeMergePayload(error, "无法清理 worktree。"));
    }
  }));

  app.post("/api/workspaces/:id/worktree-merge-agent", asyncRoute(async (req, res) => {
    const workspace = storage.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: "未找到该项目。" });
      return;
    }
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) {
      res.status(400).json({ error: "请输入合并任务书内容。" });
      return;
    }
    const systemPromptOverride = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt.trim() : "";

    // 所有系统自动发起的系统功能调用（包含 Worktree 合并）统一使用「勤劳的初二」
    const employee = storage.getSystemSiliconEmployee() ?? storage.ensureSystemSiliconEmployee();
    const candidate = selectEmployeeCandidate(employee);
    const agent = candidate.agent;
    const provider = agent.provider;
    const mode = agent.mode ?? "managed";
    const requestedEngine = agent.engine;
    const model = agent.model && agent.model !== "default"
      ? agent.model
      : resolveExplicitOrFallbackModel(config, provider, agent.model);

    const baseSystemPrompt = systemPromptOverride || [
      `你是 Wand 为项目「${workspace.name}」启动的 Worktree 合并 Agent。`,
      `项目主工作区：${workspace.cwd}`,
      "",
      employee.prompt,
    ].join("\n");

    const engineDecision = requestedEngine ? await structured.resolveNewSessionPiEngine(requestedEngine) : null;

    const snapshot = structured.createSession({
      cwd: workspace.cwd,
      mode,
      provider,
      runner: undefined,
      worktreeEnabled: false,
      model,
      thinkingEffort: agent.thinkingEffort ?? config.defaultThinkingEffort,
      sessionSource: "interactive",
      workspaceId: workspace.id,
      systemPrompt: baseSystemPrompt,
      employeeId: employee.id,
      employeeName: employee.name,
      employeeAvatar: employee.avatar,
      employeeCandidates: employee.agents,
      employeeCandidateIndex: candidate.index,
      title: `合并 Worktree - ${workspace.name}`,
      ...(engineDecision ? { engine: engineDecision.engine } : {}),
    });

    onSessionCreated?.(snapshot.cwd);
    try {
      Promise.resolve(structured.sendMessage(snapshot.id, prompt, { source: "user" })).catch((error) => {
        console.error("[wand] Accepted merge agent prompt later failed", {
          sessionId: snapshot.id,
          error: getInputDebugMeta(error),
        });
      });
    } catch (error) {
      console.error("[wand] Accepted merge agent prompt later failed", {
        sessionId: snapshot.id,
        error: getInputDebugMeta(error),
      });
    }

    res.status(201).json(wantsCompactTools(req) ? sessionResponseDTO(snapshot, req) : snapshot);
  }));
}
