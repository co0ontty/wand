// 「新建任务」对话框。
// 任务可以不挂目录：不选目录时使用全局临时目录，创建时必须选择 CLI。
// 选中已有目录时按路径复用对应分组，不再提供单独的项目创建界面。

import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import * as React from "react";

import { WandButton, WandDialogSurface, WandIcon, WandSwitch } from "../ui";
import { MilestonePicker } from "../milestones/picker";
import { milestonesStore } from "../milestones/controller";
import { workspacesController, workspacesStore } from "./controller";
import {
  httpWorkspacesRepository,
  loadNewProjectDefaults,
  suggestWorkspacePaths,
} from "./repository";
import type {
  NewProjectDefaults,
  OpenWorkspaceTaskPayload,
  RecentPath,
  Workspace,
  WorkspaceSessionKind,
  WorkspaceSessionTarget,
  WorkspaceTaskDetail,
  WorkspacesRepository,
} from "./types";
import { WORKSPACE_AGENT_OPTIONS, WorkspaceAgentPicker } from "./workspace-agent-picker";
import { describeError } from "../errors";
import { confirmDiscardTaskDraft } from "../task-draft-guard";

export interface WorkspacesHostProps {
  repository?: WorkspacesRepository;
}

/** 与服务端 resolveWorkspaceCwd 的 path.resolve 结果对齐的轻量归一化。 */
function normalizeDir(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed || "/";
}

export function WorkspacesHost({ repository = httpWorkspacesRepository }: WorkspacesHostProps) {
  const controller = useSyncExternalStore(
    workspacesStore.subscribe,
    workspacesStore.getSnapshot,
    workspacesStore.getSnapshot,
  );
  const [defaults, setDefaults] = useState<NewProjectDefaults | null>(null);
  const [projects, setProjects] = useState<Workspace[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState<WorkspaceSessionTarget>("claude");
  const [sessionKind, setSessionKind] = useState<WorkspaceSessionKind>("structured");
  const [milestoneId, setMilestoneId] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<RecentPath[]>([]);
  const [suggestionsActive, setSuggestionsActive] = useState(false);
  const draftTouched = React.useRef(false);
  // 在这个对话框里新建的迭代：目录对应的项目是提交时才建的，先把它们记下来再回填工作区。
  const createdMilestoneIds = React.useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!controller.open) return;
    draftTouched.current = false;
    const abort = new AbortController();
    setLoading(true);
    setSubmitting(false);
    setError("");
    setDefaults(null);
    setProjects([]);
    setSelectedProjectId("");
    setName("");
    setWorktreeEnabled(false);
    setPrompt("");
    setTarget("claude");
    setSessionKind("structured");
    setMilestoneId("");
    setCwd(controller.initialCwd);
    setSuggestions([]);
    setSuggestionsActive(false);
    createdMilestoneIds.current = new Set();
    void Promise.all([
      loadNewProjectDefaults(undefined, { signal: abort.signal }),
      repository.list().catch(() => [] as Workspace[]),
    ])
      .then(([loaded, listed]) => {
        if (abort.signal.aborted) return;
        setDefaults(loaded);
        setProjects(listed);
        const initial = normalizeDir(controller.initialCwd.trim()
          || workspacesStore.getRuntime()?.effectiveCwd() || loaded.defaultCwd);
        const matchingProject = initial
          ? listed.find((project) => normalizeDir(project.cwd) === initial)
          : undefined;
        setSelectedProjectId(matchingProject?.id ?? "");
        setTarget(loaded.defaultProvider);
        setSessionKind(loaded.defaultSessionKind);
        if (matchingProject) {
          setCwd(matchingProject.cwd);
        } else {
          setCwd(initial);
        }
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(describeError(loadError, "无法加载新建配置。"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [controller.initialCwd, controller.initialKind, controller.open, controller.revision, repository]);

  useEffect(() => {
    if (!controller.open || !suggestionsActive) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void suggestWorkspacePaths(cwd, undefined, { signal: abort.signal })
        .then((items) => { if (!abort.signal.aborted) setSuggestions(items); })
        .catch(() => { if (!abort.signal.aborted) setSuggestions([]); });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [controller.open, cwd, suggestionsActive]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const mountedCwd = cwd.trim();
  const milestoneWorkspaceId = selectedProject?.id ?? "";
  const setTaskCwd = (nextCwd: string): void => {
    draftTouched.current = true;
    setCwd(nextCwd);
    const matchingProject = projects.find((project) => normalizeDir(project.cwd) === normalizeDir(nextCwd));
    setSelectedProjectId(matchingProject?.id ?? "");
  };
  const hasDirectory = Boolean(selectedProject || mountedCwd);
  const effectiveCwd = selectedProject?.cwd || mountedCwd || "全局临时目录";

  async function closeDraft(): Promise<void> {
    if (submitting) return;
    if (draftTouched.current && !await confirmDiscardTaskDraft()) return;
    workspacesController.close();
  }

  async function startTaskSession(
    workspace: Pick<Workspace, "id" | "name" | "defaultProvider"> & { kind?: Workspace["kind"] },
    created: WorkspaceTaskDetail,
  ): Promise<void> {
    const runtime = workspacesStore.getRuntime();
    if (!runtime) throw new Error("新建任务运行环境尚未就绪，请刷新页面后重试。");
    const payload: OpenWorkspaceTaskPayload = {
      workspaceId: workspace.id,
      workspaceName: workspace.kind === "global" ? "" : workspace.name,
      taskId: created.id,
      taskName: created.name,
      cwd: created.cwd || created.worktree?.path || selectedProject?.cwd || mountedCwd,
    };
    if (workspace.defaultProvider) payload.provider = workspace.defaultProvider;
    await Promise.resolve(runtime.openTask(payload));
    await runtime.newTaskSession({
      workspaceId: workspace.id,
      taskId: created.id,
      cwd: payload.cwd,
      target,
      kind: target === "shell" ? "pty" : sessionKind,
      prompt: target === "shell" ? undefined : prompt.trim() || undefined,
    });
    void runtime.refreshSessions();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    if (!name.trim() && !prompt.trim()) {
      setError("任务名称和首个提示词至少填一个，任务会按提示词自动命名。");
      return;
    }
    const runtime = workspacesStore.getRuntime();
    if (!runtime) {
      setError("新建任务运行环境尚未就绪，请刷新页面后重试。");
      return;
    }
    const trimmedName = name.trim();
    workspacesController.setDismissable(false);
    setSubmitting(true);
    setError("");
    try {
      const project = selectedProject ?? (mountedCwd ? await repository.create({
        name: mountedCwd.replace(/\/+$/, "").split("/").pop() || "工作区",
        cwd: mountedCwd,
        defaultProvider: defaults?.defaultProvider,
      }) : undefined);
      const taskPrompt = prompt.trim();
      const created = project
        ? await repository.createTask(project.id, {
          name: trimmedName || undefined,
          description: taskPrompt || undefined,
          worktree: worktreeEnabled,
          milestoneId: milestoneId || null,
        })
        : await repository.createStandaloneTask({
          name: trimmedName || undefined,
          description: taskPrompt || undefined,
          cwd: mountedCwd || undefined,
          worktree: mountedCwd ? worktreeEnabled : false,
          milestoneId: milestoneId || null,
        });
      const workspace = project ?? {
        id: created.workspaceId,
        name: "",
        kind: "global" as const,
        defaultProvider: defaults?.defaultProvider,
      };
      // 目录对应的项目刚建出来：把这次新建的迭代回填到它名下。
      if (project && milestoneId && createdMilestoneIds.current.has(milestoneId)) {
        await milestonesStore.rebind(milestoneId, project.id).catch(() => undefined);
      }
      try {
        await startTaskSession(workspace, created);
        if (!created.isolated && created.worktreeError) {
          runtime.toast(created.worktreeError, "warning");
        } else {
          runtime.toast(
            selectedProject
              ? `已创建任务「${created.name}」${created.isolated ? "（独立 worktree）" : ""}`
              : mountedCwd
                ? `已创建独立任务「${created.name}」`
                : `已创建独立任务「${created.name}」（全局临时目录）`,
            "success",
          );
        }
      } catch (sessionError) {
        runtime.toast(describeError(sessionError, "任务已创建，但无法启动会话。"), "warning");
      }
      workspacesController.close();
    } catch (createError) {
      setError(describeError(createError, "创建任务失败，请检查目录是否有效。"));
    } finally {
      workspacesController.setDismissable(true);
      setSubmitting(false);
    }
  }

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) void closeDraft(); }}
      title="新建任务"
      description="任务负责分组，提示词开启其中的会话。侧边栏与看板同步。"
      className="wand-new-session-dialog wand-new-project-dialog"
      overlayClassName="wand-new-session-overlay wand-new-project-overlay"
      titleClassName="wand-new-session-title wand-new-project-title"
      descriptionClassName="wand-new-session-description wand-new-project-description"
      headerClassName="wand-new-session-header wand-new-project-header"
      closeLabel="关闭新建任务"
      testId="new-task-dialog"
      dismissable={!submitting}
    >
      {loading ? (
        <div className="wand-new-session-loading wand-new-project-loading" role="status">正在加载新建配置…</div>
      ) : (
        <form noValidate className="wand-new-session-form wand-new-project-form" aria-busy={submitting} onChangeCapture={() => { draftTouched.current = true; }} onSubmit={(event) => void submit(event)}>
          <div className="wand-new-session-body wand-new-project-body">
            <div className="wand-new-session-field wand-new-project-field">
              <label className="wand-new-session-field-label wand-new-project-field-label" htmlFor="wand-new-task-name">任务名称</label>
              <input
                id="wand-new-task-name"
                className="wand-new-session-input wand-new-project-input"
                type="text"
                value={name}
                placeholder="例如：重构会话恢复流程"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-wand-autofocus=""
                aria-describedby="wand-new-task-name-hint"
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <p id="wand-new-task-name-hint" className="wand-new-session-field-hint wand-new-project-field-hint">工作区下的分组名称，留空则用首个提示词自动总结一个名字；不会创建磁盘目录。</p>
            </div>

            <div className="wand-new-session-field wand-new-project-field">
              <label className="wand-new-session-field-label wand-new-project-field-label" htmlFor="wand-new-task-cwd">工作目录（可选）</label>
              <div className="wand-new-session-suggestions-wrap wand-new-project-suggestions-wrap">
                <input
                  id="wand-new-task-cwd"
                  className="wand-new-session-input wand-new-project-input"
                  type="text"
                  value={cwd}
                  placeholder="留空则使用全局临时目录"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-invalid={error.includes("目录") || undefined}
                  aria-describedby="wand-new-task-cwd-hint"
                  onFocus={() => setSuggestionsActive(true)}
                  onChange={(event) => setTaskCwd(event.currentTarget.value)}
                  onBlur={() => window.setTimeout(() => setSuggestionsActive(false), 120)}
                />
                {suggestionsActive && suggestions.length > 0 ? (
                  <div className="wand-new-session-suggestions wand-new-project-suggestions" role="listbox" aria-label="任务目录建议">
                    {suggestions.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        className="wand-new-session-suggestion wand-new-project-suggestion"
                        role="option"
                        aria-selected={cwd === item.path}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setTaskCwd(item.path);
                          setSuggestionsActive(false);
                        }}
                      >
                        <strong>{item.name}</strong>
                        <small className="wand-new-session-suggestion-path wand-new-project-suggestion-path">{item.path}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <p id="wand-new-task-cwd-hint" className="wand-new-session-field-hint wand-new-project-field-hint">
                留空使用临时目录；同一工作目录的任务会自动分组。
              </p>
              {defaults && defaults.recentPaths.length > 0 ? (
                <div className="wand-new-session-recent-paths wand-new-project-recent-paths" aria-label="最近使用的目录">
                  {defaults.recentPaths.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className={`wand-new-session-recent-path wand-new-project-recent-path${cwd === item.path ? " active" : ""}`}
                      title={item.path}
                      aria-pressed={cwd === item.path}
                      onClick={() => setTaskCwd(item.path)}
                    >
                      <span className="wand-new-session-recent-path-value wand-new-project-recent-path-value">{item.path}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="wand-new-session-field wand-new-project-field">
              <label className="wand-new-session-field-label" htmlFor="wand-new-task-prompt">首个会话的提示词（可选）</label>
              <textarea id="wand-new-task-prompt" className="wand-new-session-input" rows={3}
                value={prompt} disabled={submitting || target === "shell"}
                placeholder="希望 CLI 帮你完成什么？" onChange={(event) => setPrompt(event.currentTarget.value)}/>
              <p className="wand-new-session-field-hint">{target === "shell"
                ? "空白终端不会读取提示词，请填写任务名称。"
                : "提示词发送到新会话；任务名称留空时会据此自动命名，仍可随时改名。"}</p>
            </div>

            {hasDirectory ? (
              <div className="wand-new-session-field wand-new-project-field wand-new-task-milestone-field">
                <span className="wand-new-session-field-label wand-new-project-field-label" id="wand-new-task-milestone-label">里程碑（可选）</span>
                <MilestonePicker
                  value={milestoneId || null}
                  workspaceId={milestoneWorkspaceId}
                  disabled={submitting}
                  onCreated={(created) => { createdMilestoneIds.current.add(created.id); }}
                  onChange={(next) => { draftTouched.current = true; setMilestoneId(next ?? ""); }}
                />
                <p className="wand-new-session-field-hint wand-new-project-field-hint">
                  迭代按工作区归属：只列当前工作区已有的；也可以不选。
                </p>
              </div>
            ) : null}

            {hasDirectory ? (
              <details className="wand-new-session-field wand-new-project-field">
              <summary>高级：独立工作树</summary>
              <div className="wand-new-task-option" data-checked={worktreeEnabled ? "" : undefined}>
                <span className="wand-new-task-option-icon"><WandIcon name="branch" size={17} className="wand-new-task-branch-icon" strokeWidth={1.8}/></span>
                <span className="wand-new-task-option-text">
                  <span className="wand-new-task-option-label">独立 worktree 隔离</span>
                  <span className="wand-new-task-option-hint">
                    {worktreeEnabled
                      ? "为任务创建独立分支与工作树，改动隔离、可审查后合并。"
                      : "默认仅做界面分组，会话共用工作区目录。"}
                  </span>
                </span>
                <WandSwitch
                  checked={worktreeEnabled}
                  onCheckedChange={(checked) => {
                    setWorktreeEnabled(checked);
                  }}
                  ariaLabel="是否为新任务创建独立 worktree"
                />
              </div>
              </details>
            ) : null}

            <WorkspaceAgentPicker
              target={target}
              kind={sessionKind}
              disabled={submitting}
              onTargetChange={(next) => { draftTouched.current = true; setTarget(next); }}
              onKindChange={(next) => { draftTouched.current = true; setSessionKind(next); }}
            />
          </div>

          <div className="wand-new-session-summary wand-new-task-summary" aria-live="polite">
            <span>即将创建</span>
            <strong>{name.trim() || (prompt.trim() ? "按提示词自动命名" : "自动命名")}</strong>
            <span title={effectiveCwd}>{effectiveCwd}</span>
            <span>{target === "shell" ? "空白终端" : `${WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? target} · ${sessionKind === "pty" ? "PTY" : "结构化"}`}</span>
          </div>

          <div className="wand-new-session-footer wand-new-project-footer">
            <WandButton
              kind="primary"
              size="large"
              type="submit"
              className="wand-new-session-submit wand-new-project-submit"
              disabled={submitting || (!name.trim() && !prompt.trim())}
            >
              {submitting ? "正在创建…" : "创建任务"}
            </WandButton>
            {error ? <p className="wand-new-session-error wand-new-project-error" role="alert">{error}</p> : null}
          </div>
        </form>
      )}
    </WandDialogSurface>
  );
}
