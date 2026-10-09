import "../issues/library-layout";
import { Alert, AutoComplete, Collapse, Flex, Form, Radio, Space, Spin, Typography } from "antd";
import { TaskForm, TaskTextArea } from "../issues/form-controls";
import { WandInput } from "../ui";
import {
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  MODEL_CATALOG_DEFAULT_VALUE,
  pickedModelId,
  wandModelOptions,
} from "../model-catalog";
import { useWandModelCatalog } from "../use-model-catalog";
import { useProviderUsage } from "../provider-usage";
import { WandButton, WandDialogSurface, WandIcon, WandSelect } from "../ui";
import {
  UnifiedExecutionSubjectPicker,
} from "../workspaces/unified-execution-subject-picker.js";
import { useSiliconEmployees } from "../agents/employee-repository.js";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { ProviderLogo } from "../provider-logo.js";
import { AGENT_TOOL_OPTIONS, agentToolIdFor, agentToolOption } from "../../provider-identity";
import { aiTeamPickerOption, aiTeamsRepository, useAiTeamList } from "../ai-teams/repository";
import { taskBoardController } from "../issues/task-board-controller";
import { notifyTasksChanged } from "../task-changes";
import { TEAM_NEEDS_PROJECT_HINT, usableTeamWorkspaceId } from "../workspaces/workspace-agent-picker";
import { httpWorkspacesRepository } from "../workspaces/repository";
import type { Workspace } from "../workspaces/types";
import { newSessionController, newSessionStore } from "./controller";
import {
  buildCreateRequest,
  httpNewSessionRepository,
  safeMode,
  supportedModes,
} from "./repository";
import { nextChoice, type ChoiceNavigationKey } from "./choice-navigation";
import type {
  NewSessionDefaults,
  NewSessionForm,
  NewSessionKind,
  NewSessionMode,
  NewSessionProvider,
  NewSessionRepository,
} from "./types";
import { describeError } from "../errors";

export interface NewSessionHostProps {
  repository?: NewSessionRepository;
}

/**
 * 工具清单直接用浏览器层的唯一真源：Pi（CLI）与 Wand Agent（进程内 SDK）是两条独立选项，
 * 不再在这个文件里维护第二份 provider 列表。
 */

/** 当前表单选中的执行工具（provider + 引擎）；找不到时返回 null，调用方回落到 provider 名。 */
function selectedTool(form: NewSessionForm | null) {
  if (!form) return null;
  return agentToolOption(agentToolIdFor(form.provider, form.engine));
}

const MODES: ReadonlyArray<{
  value: NewSessionMode;
  label: string;
  description: string;
}> = [
  { value: "managed", label: "托管", description: "按目标连续执行" },
  { value: "full-access", label: "完全访问", description: "自动确认权限" },
  { value: "auto-edit", label: "自动编辑", description: "自动确认修改" },
  { value: "default", label: "标准", description: "使用工具默认权限配置" },
  { value: "native", label: "原生", description: "保留工具原生执行方式" },
];

/**
 * 模型的预选值：显式文字优先，空值回落到「跟随服务端默认」（与工作区选择器同一套哨兵值）。
 * 归一化 / 目录解析共用 `../model-catalog`，不在这里重写一遍。
 */
function preferredModel(selected?: string | null): string {
  return (selected ?? "").trim() || MODEL_CATALOG_DEFAULT_VALUE;
}

function modeHint({ provider, mode, kind, engine }: NewSessionForm): string {
  if (provider === "codex") {
    return "Codex 自动批准工具调用，并关闭 Codex 的沙盒限制。";
  }
  if (provider === "opencode") {
    return mode === "full-access" || mode === "managed" || mode === "auto-edit"
      ? "OpenCode 自动批准未显式拒绝的权限请求。"
      : kind === "structured"
        ? "OpenCode 使用自身权限配置；对话中未批准的工具调用会被拒绝。"
        : "OpenCode 使用自身权限配置，在终端中处理权限确认。";
  }
  if (provider === "grok") {
    return mode === "full-access" || mode === "managed"
      ? "Grok 自动批准工具权限请求。"
      : "Grok 使用自身权限配置；需要确认的操作可能等待或被阻止。";
  }
  if (provider === "qoder") {
    return "Qoder 在所有模式下都跳过工具权限确认。";
  }
  if (provider === "pi") {
    return engine === "sdk"
      ? "Wand Agent 在 Wand 内执行，使用当前会话配置的工具与扩展。"
      : "Pi CLI 使用自身工具与扩展配置；这里的模式不会增加逐项权限确认。";
  }
  if (provider === "gemini") {
    if (mode === "full-access" || mode === "managed" || (kind === "pty" && mode === "auto-edit")) {
      return "Gemini 自动批准全部工具调用。";
    }
    if (mode === "auto-edit") return "Gemini 自动批准编辑工具；其他工具仍遵循自身权限配置。";
    return kind === "structured"
      ? "Gemini 使用自身权限配置；对话中未批准的工具调用会被拒绝。"
      : "Gemini 使用自身权限配置，在终端中处理权限确认。";
  }
  if (mode === "full-access") return "Claude 自动批准工具权限请求，可连续执行修改。";
  if (mode === "auto-edit") return "Claude 自动批准文件编辑；其他工具按当前会话权限策略处理。";
  if (mode === "managed") return "Claude 按目标连续执行，并自动批准工具权限请求；缺少必要信息或工具失败时仍可能停止。";
  return "Claude 保留工具执行方式，操作请求按当前会话权限策略处理。";
}

function protocolHint(form: NewSessionForm): string {
  if (form.kind === "pty") return "终端使用 PTY，直接呈现命令行工具的交互界面与原始输出。";
  if (form.engine === "sdk") return "Wand Agent 使用 Wand 进程内 SDK，不启动 Pi CLI。";
  if (form.provider === "codex") return "对话解析 Codex 的 JSONL 事件。";
  if (form.provider === "pi" || form.provider === "opencode") return "对话解析命令行工具的 JSON 事件。";
  if (form.provider === "grok") return "对话解析 Grok 的 streaming-json 事件。";
  return "对话解析命令行工具的 stream-json 事件。";
}

function creationFallback({ provider, kind, engine }: NewSessionForm): string {
  if (kind === "shell") return "无法启动空白终端，请检查服务端 Shell 配置。";
  if (engine === "sdk") return "无法启动 Wand Agent 对话，请检查服务端 Agent 配置与模型可用性。";
  if (kind === "structured") return "无法启动对话，请检查所选工具是否可用及模型配置。";
  if (provider === "codex") return "无法启动 Codex 会话，请确认 codex 已正确安装并可在终端中执行。";
  if (provider === "opencode") return "无法启动 OpenCode 会话，请确认 opencode-ai 已正确安装。";
  if (provider === "grok") return "无法启动 Grok 会话，请确认 Grok Build CLI 已正确安装。";
  if (provider === "qoder") return "无法启动 Qoder 会话，请确认 @qoder-ai/qodercli 已正确安装。";
  if (provider === "pi") return "无法启动 Pi 会话，请确认 Pi CLI 已正确安装。";
  if (provider === "gemini") return "无法启动 Gemini 会话，请确认 Gemini CLI 已正确安装。";
  return "无法启动 Claude 会话，请确认 Claude 已正确安装。";
}

/**
 * 与服务端 `resolveWorkspaceCwd` 的 path.resolve 结果对齐的轻量归一化：
 * 团队开工要按目录找到已存在的项目 id，这里只做尾部斜杠与空白归一。
 */
function normalizeDir(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed || "/";
}

const RADIO_NAVIGATION_KEYS = new Set<ChoiceNavigationKey>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

export function NewSessionHost({ repository = httpNewSessionRepository }: NewSessionHostProps) {
  const controller = useSyncExternalStore(
    newSessionStore.subscribe,
    newSessionStore.getSnapshot,
    newSessionStore.getSnapshot,
  );
  const [defaults, setDefaults] = useState<NewSessionDefaults | null>(null);
  const [form, setForm] = useState<NewSessionForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<NewSessionDefaults["recentPaths"]>([]);
  const [suggestionsActive, setSuggestionsActive] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 目录和使用次数都在打开后请求（登录前会 401）；加载完才展示选项，避免排序跳动。
  const modelCatalog = useWandModelCatalog(controller.open);
  const providerUsage = useProviderUsage(controller.open);
  const { employees } = useSiliconEmployees({ includeArchived: true, enabled: controller.open });
  const [customizingCli, setCustomizingCli] = useState(false);
  const modeRefs = useRef<Partial<Record<NewSessionMode, HTMLInputElement | null>>>({});
  // 团队直发：
  // - 说明是服务端必填的开工输入（`boundedText(note, 1, …)`），所以只有选团队时才长这个框；
  // - 团队开工要一个**已存在**的 project id，而这一页只拿得到目录文本，所以按目录对一次项目列表。
  const [teamNote, setTeamNote] = useState("");
  const teamNoteRef = useRef<HTMLTextAreaElement | null>(null);
  const [projects, setProjects] = useState<Workspace[]>([]);
  // 任务上下文（`workspaceTaskId`）不给团队：那张卡已经在了，从这里开团只会多建一张卡（§5.1）。
  const teamContext = Boolean(controller.open && form && !form.workspaceTaskId);
  const teams = useAiTeamList(teamContext);
  const teamOptions = useMemo(() => teams?.map(aiTeamPickerOption) ?? null, [teams]);

  useEffect(() => {
    if (!controller.open) return;
    const abort = new AbortController();
    const runtime = newSessionStore.getRuntime();
    setLoading(true);
    setSubmitting(false);
    setError("");
    setDefaults(null);
    setForm(null);
    setSuggestions([]);
    setSuggestionsActive(false);
    setAdvancedOpen(false);
    setCustomizingCli(false);
    setTeamNote("");
    void repository.load({ signal: abort.signal })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        const context = runtime?.getContext();
        setDefaults(loaded);
        const initialProvider = loaded.config.defaultProvider;
        setForm({
          provider: initialProvider,
          // 上次用的是 Wand Agent 就继续预选它；其他 provider 不带引擎维度。
          engine: initialProvider === "pi" ? loaded.config.defaultEngine ?? "cli" : undefined,
          employeeId: controller.initialKind === "shell" ? undefined : controller.initialEmployeeId || undefined,
          kind: controller.initialKind
            ? controller.initialKind
            : controller.initialEmployeeId ? "structured" : loaded.config.defaultSessionKind,
          mode: safeMode(
            loaded.config.defaultProvider,
            loaded.config.defaultMode,
            loaded.config.defaultMode,
          ),
          cwd: controller.initialCwd,
          worktreeEnabled: false,
          model: preferredModel(context?.selectedModels?.[loaded.config.defaultProvider]),
          specifiedCli: false,
          workspaceId: controller.workspaceId || undefined,
          workspaceTaskId: controller.workspaceTaskId || undefined,
        });
        if (!context) setError("新建会话运行环境尚未就绪，请刷新页面后重试。");
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(describeError(loadError, "无法加载新建会话配置。"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [controller.initialCwd, controller.initialEmployeeId, controller.initialKind, controller.open, controller.revision, controller.taskName, controller.workspaceId, controller.workspaceTaskId, repository]);

  // 项目列表只在需要团队直发时读一次：拿不到就当成「没有可开工的项目」，CLI/员工会话不受影响。
  useEffect(() => {
    if (!teamContext) return;
    let alive = true;
    httpWorkspacesRepository.list().then(
      (list) => { if (alive) setProjects(list); },
      () => { if (alive) setProjects([]); },
    );
    return () => { alive = false; };
  }, [teamContext]);

  useEffect(() => {
    if (!controller.open || !form || !suggestionsActive) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void repository.suggestPaths(form.cwd, { signal: abort.signal })
        .then((items) => { if (!abort.signal.aborted) setSuggestions(items); })
        .catch(() => { if (!abort.signal.aborted) setSuggestions([]); });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [controller.open, form?.cwd, repository, suggestionsActive]);

  const selectTool = useCallback((toolId: string) => {
    const option = agentToolOption(toolId);
    if (!defaults || !option) return;
    const provider = option.provider;
    const engine = option.engine;
    // 模型跟着 provider 走：切过去时预选该 provider 上次用过的模型。
    const remembered = preferredModel(newSessionStore.getRuntime()?.getContext().selectedModels?.[provider]);
    setForm((current) => current ? {
      ...current,
      provider,
      engine,
      // Wand Agent 只跑结构化会话：切过去时把形态一起纠正，不留一个跑不了的组合。
      kind: engine === "sdk" ? "structured" : current.kind,
      model: remembered,
      mode: safeMode(provider, current.mode, defaults.config.defaultMode),
    } : current);
    const currentMode = form
      ? safeMode(provider, form.mode, defaults.config.defaultMode)
      : safeMode(provider, defaults.config.defaultMode, defaults.config.defaultMode);
    void repository.savePreferences({ defaultProvider: provider, defaultEngine: engine ?? "cli", defaultMode: currentMode })
      .catch((saveError) => console.warn("[wand] Failed to persist new-session defaults", saveError));
  }, [defaults, form, repository]);

  const selectKind = useCallback((kind: NewSessionKind) => {
    setForm((current) => current ? { ...current, kind,
      model: kind !== "structured" && current.model.startsWith("wand-openrouter-free/") ? "default" : current.model } : current);
    if (kind !== "structured") setAdvancedOpen(true);
    if (kind !== "shell") {
      void repository.savePreferences({ defaultSessionKind: kind })
        .catch((saveError) => console.warn("[wand] Failed to persist new-session defaults", saveError));
    }
  }, [repository]);

  const selectMode = useCallback((mode: NewSessionMode) => {
    if (!form || !supportedModes(form.provider).includes(mode)) return;
    setForm((current) => current ? { ...current, mode } : current);
    void repository.savePreferences({ defaultMode: mode })
      .catch((saveError) => console.warn("[wand] Failed to persist new-session defaults", saveError));
  }, [form, repository]);

  const selectModel = useCallback((model: string) => {
    setForm((current) => current ? { ...current, model } : current);
    // 写回按 provider 的记忆，与任务选择器 / composer 同一份。
    newSessionStore.getRuntime()?.rememberModel(form?.provider ?? "claude", pickedModelId(model));
  }, [form?.provider]);

  const supportedModesForProvider = useMemo(
    () => form ? supportedModes(form.provider) : [],
    [form?.provider],
  );
  const supported = useMemo(() => new Set(supportedModesForProvider), [supportedModesForProvider]);
  const effectiveCwd = form?.cwd.trim()
    || newSessionStore.getRuntime()?.getContext().effectiveCwd
    || defaults?.config.defaultCwd
    || "当前工作目录";
  const selectedMode = form ? MODES.find((mode) => mode.value === form.mode) : undefined;
  const selectedEmployee = form?.employeeId ? employees.find((emp) => emp.id === form.employeeId) : null;
  const selectedTeam = form?.teamId ? teams?.find((team) => team.id === form.teamId) ?? null : null;
  // 目录改了也要重新对项目：手输目录和对不上项目的目录都拿不到 teamWorkspaceId，整组就禁用。
  // 留空时用真正会生效的目录（运行时当前目录或服务端默认），不让「什么都没填」把团队卡死。
  const projectCwd = form?.cwd.trim()
    || newSessionStore.getRuntime()?.getContext().effectiveCwd
    || defaults?.config.defaultCwd
    || "";
  const matchedProject = projects.find((project) => normalizeDir(project.cwd) === normalizeDir(projectCwd));
  const teamWorkspaceId = form?.workspaceTaskId
    ? ""
    : usableTeamWorkspaceId(form?.workspaceId ?? matchedProject?.id, matchedProject?.kind);

  // 目录一改，原来选中的团队可能就没项目可开工了：清掉选择态，不留一个看不见的团队。
  useEffect(() => {
    if (!form?.teamId || teamWorkspaceId) return;
    setForm((current) => current ? { ...current, teamId: undefined } : current);
  }, [form?.teamId, teamWorkspaceId]);
  // 选中团队就把光标落到说明框：开工说明是唯一必填输入。
  useEffect(() => {
    if (!form?.teamId) return;
    teamNoteRef.current?.focus();
  }, [form?.teamId]);

  function navigateChoice<T extends string>(
    event: KeyboardEvent<HTMLElement>,
    current: T,
    values: readonly T[],
    choose: (value: T) => void,
    refs: MutableRefObject<Partial<Record<T, HTMLElement | null>>>,
  ): void {
    if (!RADIO_NAVIGATION_KEYS.has(event.key as ChoiceNavigationKey)) return;
    event.preventDefault();
    const next = nextChoice(values, current, event.key as ChoiceNavigationKey);
    choose(next);
    window.requestAnimationFrame(() => refs.current[next]?.focus());
  }

  /**
   * 团队直发（§5.1 修正 B8）：选团队时这一页不建任务卡也不开会话，由直发路由自己建 `team_direct` 卡。
   * 成功后原位停够 dwell 再前进：能拿到 `chatSessionId` 就落到 IM 群聊页，否则退回团队页看这一轮。
   */
  async function startDirectTeamRun(current: NewSessionForm): Promise<void> {
    const teamId = current.teamId ?? "";
    if (!teamId) return;
    const workspaceId = current.workspaceTaskId
      ? ""
      : usableTeamWorkspaceId(current.workspaceId ?? matchedProject?.id, matchedProject?.kind);
    if (!workspaceId) {
      // 不静默：禁用态可能被绕过（例如选完团队又把目录清空），这里原位说明。
      setError(TEAM_NEEDS_PROJECT_HINT);
      return;
    }
    const note = teamNote.trim();
    if (!note) {
      setError("先写一句本轮说明：团队要有明确目标才能开工。");
      teamNoteRef.current?.focus();
      return;
    }
    try {
      const started = await aiTeamsRepository.startDirect(teamId, { note, workspaceId });
      const sessionId = started.run.chatSessionId;
      await aiTeamsRepository.settle("success");
      taskBoardController.close();
      newSessionController.close();
      // 开团后首屏直接进 IM 群聊页（§5.1 路径 a 走 teamchat），和侧栏点群聊条目一致。
      if (sessionId) taskBoardController.open("", "", "teamchat", started.run.id);
      else taskBoardController.open("", "", "teams");
      // 侧栏群聊徽标来自 /api/tasks：开团后主动通知一次，不等 ~6s 轮询。
      notifyTasksChanged();
    } catch (cause) {
      setError(describeError(cause, "开工失败，请选择已有项目后重试。"));
      await aiTeamsRepository.settle("error");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!form || !defaults || submitting) return;
    const runtime = newSessionStore.getRuntime();
    if (!runtime) {
      setError("新建会话运行环境尚未就绪，请刷新页面后重试。");
      return;
    }
    newSessionController.setDismissable(false);
    setSubmitting(true);
    setError("");
    try {
      // 团队分支：既不建任务卡也不起会话，走直发路由（它自己建 team_direct 卡）。
      if (form.teamId) {
        await startDirectTeamRun(form);
        return;
      }
      const request = buildCreateRequest(form, defaults.config, runtime.getContext());
      const dimensions = await runtime.prepareCreate(request.kind, request);
      if (request.kind !== "structured") Object.assign(request, dimensions);
      void repository.savePreferences({
        ...(request.kind === "shell" ? {} : {
          ...(!form.employeeId ? { defaultProvider: request.provider } : {}),
          // 引擎跟 provider 一起记：下次打开还预选 Wand Agent 而不是悄悄回到 Pi CLI。
          ...(request.kind === "structured" && request.provider === "pi"
            ? { defaultEngine: form.engine ?? "cli" } : {}),
          defaultSessionKind: request.kind,
          defaultMode: request.mode,
        }),
      }).catch((saveError) => console.warn("[wand] Failed to persist new-session defaults", saveError));
      const created = await repository.create(request);
      await runtime.completeCreate(request, created);
      newSessionController.close();
    } catch (createError) {
      setError(describeError(createError, creationFallback(form)));
    } finally {
      newSessionController.setDismissable(true);
      setSubmitting(false);
    }
  }

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) newSessionController.close(); }}
      title={controller.taskName ? `新对话 · ${controller.taskName}` : "新对话"}
      description="选择由谁执行、使用对话还是终端，再确认工作目录。"
      className="wand-task-library-dialog wand-new-session-library-dialog"
      closeLabel="关闭新建会话"
      testId="new-session-dialog"
      dismissable={!submitting}
    >
      {loading || (controller.open && providerUsage === null) ? <Spin tip="正在加载新建会话配置…"><div style={{ minHeight: 100 }} role="status">正在加载新建会话配置…</div></Spin> : form && defaults ? (
        <TaskForm noValidate aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <Flex vertical gap={16}>
            {form.employeeId ? (
              <div className="wand-new-session-employee-section">
                <Flex
                  align="center"
                  justify="space-between"
                  gap={12}
                  className="wand-new-session-logo-bar"
                  style={{
                    padding: "12px 16px",
                    borderRadius: 8,
                    border: "1px solid var(--wand-border-subtle, rgba(255, 255, 255, 0.08))",
                    background: "var(--wand-bg-card, rgba(255, 255, 255, 0.03))",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                  }}
                  onClick={() => setCustomizingCli(!customizingCli)}
                >
                  <Flex align="center" gap={12} style={{ minWidth: 0, flex: 1 }}>
                    <button
                      type="button"
                      className="wand-new-session-logo-toggle"
                      title={customizingCli ? "收起工具切换" : "切换执行工具和模型"}
                      aria-label={customizingCli ? "收起工具切换" : "切换执行工具和模型"}
                      aria-expanded={customizingCli}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setCustomizingCli(!customizingCli);
                      }}
                    >
                      <EmployeeAvatar
                        employee={selectedEmployee || { id: form.employeeId, name: "员工" }}
                        provider={form.specifiedCli ? form.provider : undefined}
                        size="lg"
                      />
                    </button>
                    <Flex vertical style={{ minWidth: 0, flex: 1 }}>
                      <Flex align="center" gap={8}>
                        <Typography.Text strong ellipsis style={{ fontSize: 15 }}>
                          {selectedEmployee?.name || "硅基员工"}
                        </Typography.Text>
                        <Typography.Text
                          type="secondary"
                          style={{
                            fontSize: 12,
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: form.specifiedCli
                              ? "var(--wand-brand-bg, rgba(99, 102, 241, 0.15))"
                              : "var(--wand-bg-tag, rgba(255, 255, 255, 0.08))",
                            color: form.specifiedCli
                              ? "var(--wand-brand, #818cf8)"
                              : "inherit",
                          }}
                        >
                          {form.specifiedCli ? "已指定工具" : "按员工配置启动"}
                        </Typography.Text>
                      </Flex>
                      <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                        {form.specifiedCli
                          ? `工具：${selectedTool(form)?.label || form.provider} · 模型：${preferredModel(form.model)}`
                          : "按员工配置的工具与模型候选顺序启动"}
                      </Typography.Text>
                    </Flex>
                  </Flex>
                  <WandButton
                    kind="ghost"
                    size="small"
                    type="button"
                    aria-expanded={customizingCli}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCustomizingCli(!customizingCli);
                    }}
                  >
                    {customizingCli ? "收起" : "指定 CLI / 模型"}
                  </WandButton>
                </Flex>

                {customizingCli ? (
                  <Flex
                    vertical
                    gap={12}
                    className="wand-new-session-custom-cli-panel"
                    style={{
                      marginTop: 8,
                      padding: "12px 14px",
                      borderRadius: 8,
                      border: "1px dashed var(--wand-border-subtle, rgba(255, 255, 255, 0.12))",
                      background: "var(--wand-bg-panel, rgba(0, 0, 0, 0.1))",
                    }}
                  >
                    <Form.Item label="选择执行工具" style={{ marginBottom: 0 }}>
                      <Radio.Group
                        value={form.specifiedCli ? agentToolIdFor(form.provider, form.engine) : "default_dispatch"}
                        disabled={submitting}
                        style={{ width: "100%" }}
                        onChange={(event) => {
                          const val = event.target.value;
                          if (val === "default_dispatch") {
                            setForm((current) => current ? { ...current, specifiedCli: false } : current);
                          } else {
                            setForm((current) => current ? { ...current, specifiedCli: true } : current);
                            selectTool(val);
                          }
                        }}
                      >
                        <Flex vertical gap={8}>
                          <Radio value="default_dispatch">
                            <Flex align="center" gap={8}>
                              <EmployeeAvatar
                                employee={selectedEmployee || { id: form.employeeId, name: "员工" }}
                                size="sm"
                              />
                              <Flex vertical>
                                <Typography.Text strong>员工默认派发</Typography.Text>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  按员工配置的候选顺序尝试工具与模型
                                </Typography.Text>
                              </Flex>
                            </Flex>
                          </Radio>
                          {AGENT_TOOL_OPTIONS.map((tool) => (
                            <Radio key={tool.id} value={tool.id}>
                              <Flex align="center" gap={8}>
                                {tool.engine === "sdk"
                                  ? <WandIcon name="spark" size={20}/>
                                  : <ProviderLogo provider={tool.provider} className="wand-subject-provider" />}
                                <Flex vertical>
                                  <Typography.Text strong>{tool.label}</Typography.Text>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    {tool.description}
                                  </Typography.Text>
                                </Flex>
                              </Flex>
                            </Radio>
                          ))}
                        </Flex>
                      </Radio.Group>
                    </Form.Item>

                    {form.specifiedCli ? (
                      <Form.Item
                        label="指定模型"
                        style={{ marginBottom: 0 }}
                        extra="所选模型随会话启动一起提交；「跟随服务端默认」沿用服务端配置的默认模型。"
                      >
                        <WandSelect
                          value={preferredModel(form.model)}
                          options={wandModelOptions(modelCatalog, form.provider).filter(
                            (option) => form.kind === "structured" || !option.value.startsWith("wand-openrouter-free/"),
                          )}
                          ariaLabel="模型"
                          searchable
                          searchPlaceholder="搜索模型"
                          disabled={submitting}
                          className="wand-new-session-model-select"
                          onValueChange={selectModel}
                        />
                      </Form.Item>
                    ) : null}

                    <Flex justify="space-between" align="center" style={{ paddingTop: 4 }}>
                      <WandButton
                        kind="ghost"
                        size="small"
                        type="button"
                        onClick={() => {
                          setForm((current) => current ? { ...current, employeeId: undefined, specifiedCli: undefined } : current);
                          setCustomizingCli(false);
                        }}
                      >
                        选择其他执行者
                      </WandButton>
                      {form.specifiedCli ? (
                        <WandButton
                          kind="ghost"
                          size="small"
                          type="button"
                          onClick={() => {
                            setForm((current) => current ? { ...current, specifiedCli: false } : current);
                          }}
                        >
                          恢复员工默认派发
                        </WandButton>
                      ) : null}
                    </Flex>
                  </Flex>
                ) : null}
              </div>
            ) : (
              <UnifiedExecutionSubjectPicker
                selectedSubject={form.teamId
                  ? { type: "team", id: form.teamId }
                  : form.employeeId
                    ? { type: "employee", id: form.employeeId }
                    : { type: "cli", id: form.kind === "shell" ? "shell" : form.provider,
                        ...(form.engine ? { engine: form.engine } : {}) }}
                kind={form.kind === "shell" ? "pty" : form.kind}
                model={form.model}
                showModel={false}
                teams={teamContext ? teamOptions : null}
                teamWorkspaceId={teamWorkspaceId}
                disabled={submitting}
                onSubjectChange={(subj) => {
                  if (subj.type === "team") {
                    setForm((current) => current
                      ? { ...current, teamId: subj.id, employeeId: undefined, specifiedCli: undefined }
                      : current);
                    return;
                  }
                  if (subj.type === "cli") {
                    if (subj.id === "shell") {
                      setForm((current) => current
                        ? { ...current, teamId: undefined, employeeId: undefined, kind: "shell", specifiedCli: undefined }
                        : current);
                    } else {
                      setForm((current) => current
                        ? { ...current, teamId: undefined, employeeId: undefined, kind: current.kind === "shell" ? "pty" : current.kind, specifiedCli: undefined }
                        : current);
                      selectTool(agentToolIdFor(subj.id as NewSessionProvider, subj.engine));
                    }
                  } else if (subj.type === "employee") {
                    setForm((current) => current
                      ? { ...current, teamId: undefined, employeeId: subj.id, kind: "structured", specifiedCli: false }
                      : current);
                  }
                }}
                onKindChange={(nextKind) => {
                  if (nextKind === "pty") {
                    setForm((current) => current ? { ...current, teamId: undefined, employeeId: undefined, specifiedCli: undefined } : current);
                  }
                  selectKind(nextKind);
                }}
                onModelChange={(nextModel) => selectModel(nextModel)}
              />
            )}
            {form.teamId ? <Form.Item label="本轮说明" htmlFor="wand-new-session-team-note"
              extra={<Typography.Text id="wand-new-session-team-note-hint" type="secondary">团队按这句话拆解与验收；开工后首屏直接进群聊页看进展。</Typography.Text>}>
              <TaskTextArea className="resize-none" id="wand-new-session-team-note" ref={teamNoteRef}
                rows={3} maxLength={4000} required value={teamNote} disabled={submitting}
                aria-describedby="wand-new-session-team-note-hint" placeholder="一句话说清要他们做什么"
                onChange={(event) => setTeamNote(event.currentTarget.value)}/>
            </Form.Item> : null}
            <Form.Item htmlFor="wand-new-session-cwd" label="工作目录" extra={<Typography.Text id="wand-new-session-cwd-hint" type="secondary">留空则使用当前目录，支持路径自动补全。</Typography.Text>}>
              <AutoComplete style={{ width: "100%" }} value={form.cwd} disabled={submitting}
                open={suggestionsActive && suggestions.length > 0}
                options={suggestions.map((item) => ({ value: item.path, label: <Flex vertical><Typography.Text strong>{item.name}</Typography.Text><Typography.Text type="secondary">{item.path}</Typography.Text></Flex> }))}
                onChange={(cwd) => setForm({ ...form, cwd })}
                onSelect={(cwd) => { setForm({ ...form, cwd }); setSuggestionsActive(false); }}
                onFocus={() => setSuggestionsActive(true)} onBlur={() => setSuggestionsActive(false)}>
                <WandInput id="wand-new-session-cwd" type="text"
                  placeholder={newSessionStore.getRuntime()?.getContext().effectiveCwd || defaults.config.defaultCwd}
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  aria-invalid={error.includes("目录") || undefined} aria-describedby="wand-new-session-cwd-hint"/>
              </AutoComplete>
              {defaults.recentPaths.length > 0 ? <Space wrap aria-label="最近使用的工作目录" style={{ marginTop: 8 }}>
                {defaults.recentPaths.map((item) => <WandButton kind={form.cwd === item.path ? "outline" : "ghost"} size="small"
                  key={item.path} type="button" title={item.path} aria-pressed={form.cwd === item.path}
                  onClick={() => setForm({ ...form, cwd: item.path })}>
                  <Typography.Text ellipsis style={{ maxWidth: 180 }}>{item.path}</Typography.Text>
                </WandButton>)}
              </Space> : null}
            </Form.Item>
            {form.kind !== "shell" && !form.employeeId && !form.teamId ? <Form.Item label="模型" extra="所选模型随会话启动一起提交；「跟随服务端默认」沿用服务端配置的默认模型。">
              <WandSelect value={preferredModel(form.model)}
                options={wandModelOptions(modelCatalog, form.provider).filter((option) => form.kind === "structured" || !option.value.startsWith("wand-openrouter-free/"))}
                ariaLabel="模型" searchable searchPlaceholder="搜索模型" disabled={submitting}
                className="wand-new-session-model-select" onValueChange={selectModel}/>
            </Form.Item> : null}
            <Collapse activeKey={advancedOpen ? ["advanced"] : []}
              onChange={(keys) => setAdvancedOpen(keys.includes("advanced"))}
              items={[{ key: "advanced", label: "高级选项", extra: <Typography.Text type="secondary">{form.teamId ? "按成员员工配置执行" : form.employeeId ? (form.specifiedCli ? selectedMode?.label ?? "标准" : "按员工工具链执行") : form.kind === "shell" ? "Shell 环境" : selectedMode?.label ?? "标准"}</Typography.Text>, children:
                form.teamId ? <Typography.Text type="secondary">团队开工不另选模式与模型：负责人拆解，成员各用自己的员工配置与候选链执行。</Typography.Text>
                : form.employeeId && !form.specifiedCli ? <Typography.Text type="secondary">模型、权限与候选顺序由员工配置决定。可在硅基员工页修改。</Typography.Text>
                : form.kind !== "shell" ? <Flex vertical gap={12}><Form.Item label="执行模式" style={{ marginBottom: 0 }}>
                  <Radio.Group aria-label="执行模式" value={form.mode} disabled={submitting} onChange={(event) => selectMode(event.target.value)}>
                    <Space wrap>{MODES.map((mode) => <Radio.Button key={mode.value} value={mode.value} disabled={!supported.has(mode.value)} title={mode.description}
                      ref={(element) => { modeRefs.current[mode.value] = element?.input ?? null; }}
                      onKeyDown={(event) => navigateChoice(event, form.mode, supportedModesForProvider, selectMode, modeRefs)}>{mode.label}</Radio.Button>)}</Space>
                  </Radio.Group>
                </Form.Item><Typography.Text type="secondary">{protocolHint(form)}</Typography.Text></Flex>
                : <Typography.Text type="secondary">空白终端使用服务端配置的登录 Shell，不应用 AI 权限模式。</Typography.Text>
              }]}/>
            <Alert type="info" title="即将启动" description={<Flex vertical gap={4} aria-live="polite">
              <Typography.Text strong>
                {form.teamId
                  ? `${selectedTeam?.name ?? "AI 团队"} · 团队开工`
                  : form.employeeId
                  ? `${selectedEmployee?.name || "硅基员工"} · ${form.specifiedCli ? `${selectedTool(form)?.label || form.provider} · 对话` : "按员工配置启动"}`
                  : form.kind === "shell"
                    ? "空白终端 · Shell"
                    : `${selectedTool(form)?.label ?? form.provider} · ${form.kind === "structured" ? "对话" : "终端"}`}
              </Typography.Text>
              <Typography.Text ellipsis title={effectiveCwd}>{effectiveCwd}</Typography.Text>
              <Typography.Text type="secondary">
                {form.teamId
                  ? teamNote.trim() || "还没写本轮说明"
                  : form.employeeId
                  ? form.specifiedCli
                    ? `指定模型：${preferredModel(form.model)}`
                    : "工具、模型与权限跟随员工配置"
                  : form.kind === "shell"
                    ? "直接使用系统 Shell，不启动 AI 工具"
                    : `${selectedMode?.label ?? "标准"} · ${modeHint(form)}`}
              </Typography.Text>
              {form.employeeId && form.specifiedCli ? <Typography.Text type="secondary">{modeHint(form)}</Typography.Text> : null}
            </Flex>}/>
            {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
            <Flex justify="flex-end" gap={8} className="wand-dialog-sticky-actions">
              <WandButton kind="ghost" disabled={submitting} onClick={() => newSessionController.close()}>取消</WandButton>
              <WandButton className="wand-new-session-submit" kind="primary" type="submit" disabled={submitting}>
                {submitting ? (form.teamId ? "正在开工…" : "正在启动…") : form.teamId ? "直接开工" : form.kind === "shell" ? "启动空白终端" : form.employeeId ? "启动员工会话" : "启动会话"}
              </WandButton>
            </Flex>
          </Flex>
        </TaskForm>
      ) : error ? <Alert type="error" showIcon role="alert" title={error} action={<WandButton kind="primary" onClick={() => newSessionController.open()}>重试</WandButton>}/> : null}
    </WandDialogSurface>
  );
}
