// 「新建任务」对话框。
// 任务可以不挂目录：不选目录时使用全局临时目录，创建时必须选择 CLI。
// 选中已有目录时按路径复用对应分组，不再提供单独的项目创建界面。

import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";

import { WandButton, WandDialogSurface, WandIcon, WandSwitch } from "../ui";
import { workspacesController, workspacesStore } from "./controller";
import { httpNewSessionRepository } from "../new-session/repository";
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

export interface WorkspacesHostProps {
  repository?: WorkspacesRepository;
}

function presentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === "Failed to fetch") return fallback;
  return error.message;
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
  const [worktreeEnabled, setWorktreeEnabled] = useState(true);
  const [target, setTarget] = useState<WorkspaceSessionTarget>("claude");
  const [sessionKind, setSessionKind] = useState<WorkspaceSessionKind>("structured");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<RecentPath[]>([]);
  const [suggestionsActive, setSuggestionsActive] = useState(false);

  useEffect(() => {
    if (!controller.open) return;
    const abort = new AbortController();
    setLoading(true);
    setSubmitting(false);
    setError("");
    setDefaults(null);
    setProjects([]);
    setSelectedProjectId("");
    setName("");
    setWorktreeEnabled(true);
    setTarget("claude");
    setSessionKind("structured");
    setCwd(controller.initialCwd);
    setSuggestions([]);
    setSuggestionsActive(false);
    void Promise.all([
      loadNewProjectDefaults(undefined, { signal: abort.signal }),
      repository.list().catch(() => [] as Workspace[]),
    ])
      .then(([loaded, listed]) => {
        if (abort.signal.aborted) return;
        setDefaults(loaded);
        setProjects(listed);
        const initial = controller.initialCwd.trim() ? normalizeDir(controller.initialCwd) : "";
        const matchingProject = initial
          ? listed.find((project) => normalizeDir(project.cwd) === initial)
          : undefined;
        setSelectedProjectId(matchingProject?.id ?? "");
        setWorktreeEnabled(loaded.defaultTaskWorktree);
        setTarget(loaded.defaultProvider);
        setSessionKind(loaded.defaultSessionKind);
        if (matchingProject) {
          setCwd(matchingProject.cwd);
        } else {
          setCwd(controller.initialCwd);
        }
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(presentError(loadError, "无法加载新建配置。"));
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
  const setTaskCwd = (nextCwd: string): void => {
    setCwd(nextCwd);
    const matchingProject = projects.find((project) => normalizeDir(project.cwd) === normalizeDir(nextCwd));
    setSelectedProjectId(matchingProject?.id ?? "");
  };
  const hasDirectory = Boolean(selectedProject || mountedCwd);
  const effectiveCwd = selectedProject?.cwd || mountedCwd || "全局临时目录";

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
    });
    void runtime.refreshSessions();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
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
      const created = selectedProject
        ? await repository.createTask(selectedProject.id, {
          name: trimmedName || undefined,
          worktree: worktreeEnabled,
        })
        : await repository.createStandaloneTask({
          name: trimmedName || undefined,
          cwd: mountedCwd || undefined,
          worktree: mountedCwd ? worktreeEnabled : false,
        });
      const workspace = selectedProject ?? {
        id: created.workspaceId,
        name: "",
        kind: "global" as const,
        defaultProvider: defaults?.defaultProvider,
      };
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
        runtime.toast(presentError(sessionError, "任务已创建，但无法启动会话。"), "warning");
      }
      workspacesController.close();
    } catch (createError) {
      setError(presentError(createError, "创建任务失败，请检查目录是否有效。"));
    } finally {
      workspacesController.setDismissable(true);
      setSubmitting(false);
    }
  }

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) workspacesController.close(); }}
      title="新建任务"
      description="可以不选目录（使用全局临时目录），也可以挂载一个目录。创建任务时必须选择 CLI。"
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
        <form className="wand-new-session-form wand-new-project-form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
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
              <p id="wand-new-task-name-hint" className="wand-new-session-field-hint wand-new-project-field-hint">可选；留空时会在发布任务后自动命名。</p>
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
                可选。挂载后任务在该目录运行，不挂载则使用全局临时目录。已有目录会自动归入对应分组。
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

            {hasDirectory ? (
              <div className="wand-new-task-option" data-checked={worktreeEnabled ? "" : undefined}>
                <span className="wand-new-task-option-icon"><WandIcon name="branch" size={17} className="wand-new-task-branch-icon" strokeWidth={1.8}/></span>
                <span className="wand-new-task-option-text">
                  <span className="wand-new-task-option-label">独立 worktree 隔离</span>
                  <span className="wand-new-task-option-hint">
                    {worktreeEnabled
                      ? "为任务创建独立分支与工作树，改动隔离、可审查后合并。"
                      : "会话直接运行在任务目录；非 git 目录自动用这种模式。"}
                  </span>
                </span>
                <WandSwitch
                  checked={worktreeEnabled}
                  onCheckedChange={(checked) => {
                    setWorktreeEnabled(checked);
                    void httpNewSessionRepository.savePreferences({ defaultTaskWorktree: checked }).catch(() => undefined);
                  }}
                  ariaLabel="是否为新任务创建独立 worktree"
                />
              </div>
            ) : null}

            <WorkspaceAgentPicker
              target={target}
              kind={sessionKind}
              disabled={submitting}
              onTargetChange={setTarget}
              onKindChange={setSessionKind}
            />
          </div>

          <div className="wand-new-session-summary wand-new-task-summary" aria-live="polite">
            <span>即将创建</span>
            <strong>{name.trim() || "未命名任务"}</strong>
            <span title={effectiveCwd}>{effectiveCwd}</span>
            <span>{target === "shell" ? "空白终端" : `${WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? target} · ${sessionKind === "pty" ? "PTY" : "结构化"}`}</span>
          </div>

          <div className="wand-new-session-footer wand-new-project-footer">
            <WandButton
              kind="primary"
              size="large"
              type="submit"
              className="wand-new-session-submit wand-new-project-submit"
              disabled={submitting}
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
