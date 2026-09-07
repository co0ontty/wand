// 「新建项目 / 任务」对话框。
// 任务可以不挂项目：不选目录时使用全局临时目录，创建时必须选择 CLI。
// 项目必须挂目录，创建后进入空白全页 CLI / 会话类型选择。

import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";

import { WandButton, WandDialogSurface, WandIcon, WandSwitch } from "../ui";
import { workspacesController, workspacesStore, type WorkspaceCreationKind } from "./controller";
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
  const [creationKind, setCreationKind] = useState<WorkspaceCreationKind>(controller.initialKind);
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
    setCreationKind(controller.initialKind);
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
        if (controller.initialKind === "project") {
          setCwd((current) => current || loaded.defaultCwd || workspacesStore.getRuntime()?.effectiveCwd() || "");
        } else if (matchingProject) {
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
  const isProject = creationKind === "project";
  const mountedCwd = cwd.trim();
  const hasDirectory = Boolean(selectedProject || mountedCwd);
  const effectiveCwd = selectedProject?.cwd
    || mountedCwd
    || (isProject
      ? (workspacesStore.getRuntime()?.effectiveCwd() || defaults?.defaultCwd || "请选择项目目录")
      : "全局临时目录");

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
    if (!trimmedName) {
      setError(isProject ? "请输入项目名称。" : "请输入任务名称。");
      return;
    }
    workspacesController.setDismissable(false);
    setSubmitting(true);
    setError("");
    try {
      if (isProject) {
        const trimmedCwd = mountedCwd || runtime.effectiveCwd();
        if (!trimmedCwd) {
          setError("项目必须选择一个目录。");
          return;
        }
        const createdProject = await repository.create({
          name: trimmedName,
          cwd: trimmedCwd,
          defaultProvider: defaults?.defaultProvider,
        });
        runtime.openWorkspace(createdProject);
        void runtime.refreshSessions();
        runtime.toast(`已创建项目「${createdProject.name}」`, "success");
        workspacesController.close();
        return;
      }

      if (selectedProject) {
        const created = await repository.createTask(selectedProject.id, {
          name: trimmedName,
          worktree: worktreeEnabled,
        });
        await startTaskSession(selectedProject, created);
        if (!created.isolated && created.worktreeError) {
          runtime.toast(created.worktreeError, "warning");
        } else {
          runtime.toast(
            `已创建任务「${created.name}」${created.isolated ? "（独立 worktree）" : ""}`,
            "success",
          );
        }
        workspacesController.close();
        return;
      }

      const created = await repository.createStandaloneTask({
        name: trimmedName,
        cwd: mountedCwd || undefined,
        worktree: mountedCwd ? worktreeEnabled : false,
      });
      await startTaskSession({
        id: created.workspaceId,
        name: "",
        kind: "global",
        defaultProvider: defaults?.defaultProvider,
      }, created);
      if (!created.isolated && created.worktreeError) {
        runtime.toast(created.worktreeError, "warning");
      } else {
        runtime.toast(
          mountedCwd
            ? `已创建独立任务「${created.name}」`
            : `已创建独立任务「${created.name}」（全局临时目录）`,
          "success",
        );
      }
      workspacesController.close();
    } catch (createError) {
      setError(presentError(
        createError,
        isProject ? "创建项目失败，请检查目录是否有效。" : "创建任务失败，请检查目录是否有效。",
      ));
    } finally {
      workspacesController.setDismissable(true);
      setSubmitting(false);
    }
  }

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) workspacesController.close(); }}
      title={isProject ? "新建项目" : "新建任务"}
      description={isProject
        ? "项目必须挂载一个目录。创建后是空白工作台，在全页选择 CLI 和结构化 / PTY。"
        : "可以不挂项目、不选目录（使用全局临时目录），也可以挂载目录或归属已有项目。创建任务时必须选择 CLI。"}
      className="wand-new-session-dialog wand-new-project-dialog"
      overlayClassName="wand-new-session-overlay wand-new-project-overlay"
      titleClassName="wand-new-session-title wand-new-project-title"
      descriptionClassName="wand-new-session-description wand-new-project-description"
      headerClassName="wand-new-session-header wand-new-project-header"
      closeLabel={isProject ? "关闭新建项目" : "关闭新建任务"}
      testId="new-task-dialog"
      dismissable={!submitting}
    >
      {loading ? (
        <div className="wand-new-session-loading wand-new-project-loading" role="status">正在加载新建配置…</div>
      ) : (
        <form className="wand-new-session-form wand-new-project-form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <div className="wand-new-session-body wand-new-project-body">
            <div className="wand-workspace-creation-kind" role="tablist" aria-label="创建分类">
              <button
                type="button"
                role="tab"
                aria-selected={!isProject}
                className={`wand-workspace-creation-kind-option${!isProject ? " active" : ""}`}
                onClick={() => {
                  setCreationKind("task");
                  if (!selectedProjectId) setCwd("");
                }}
              >
                <WandIcon name="task" size={15}/><span>任务</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isProject}
                className={`wand-workspace-creation-kind-option${isProject ? " active" : ""}`}
                onClick={() => {
                  setCreationKind("project");
                  if (!cwd.trim()) {
                    setCwd(defaults?.defaultCwd || workspacesStore.getRuntime()?.effectiveCwd() || "");
                  }
                }}
              >
                <WandIcon name="folder" size={15}/><span>项目</span>
              </button>
            </div>
            <div className="wand-new-session-field wand-new-project-field">
              <label className="wand-new-session-field-label wand-new-project-field-label" htmlFor="wand-new-task-name">{isProject ? "项目名称" : "任务名称"}</label>
              <input
                id="wand-new-task-name"
                className="wand-new-session-input wand-new-project-input"
                type="text"
                value={name}
                placeholder={isProject ? "例如：Wand 控制台" : "例如：重构会话恢复流程"}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-wand-autofocus=""
                aria-describedby="wand-new-task-name-hint"
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <p id="wand-new-task-name-hint" className="wand-new-session-field-hint wand-new-project-field-hint">{isProject ? "用于在项目列表里识别这个项目。" : "用于在任务列表里识别这个任务。"}</p>
            </div>

            {!isProject ? (
              <div className="wand-new-session-field wand-new-project-field">
                <label className="wand-new-session-field-label wand-new-project-field-label" htmlFor="wand-new-task-project">所属项目</label>
                <select
                  id="wand-new-task-project"
                  className="wand-new-session-input wand-new-project-input wand-workspace-project-select"
                  value={selectedProjectId}
                  onChange={(event) => {
                    const nextId = event.currentTarget.value;
                    const project = projects.find((item) => item.id === nextId);
                    setSelectedProjectId(nextId);
                    if (project) setCwd(project.cwd);
                  }}
                >
                  <option value="">不挂项目（独立任务）</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
                <p className="wand-new-session-field-hint wand-new-project-field-hint">
                  独立任务不依赖项目；留空目录时使用全局临时目录。
                </p>
              </div>
            ) : null}

            {selectedProject && !isProject ? null : (
              <div className="wand-new-session-field wand-new-project-field">
                <label className="wand-new-session-field-label wand-new-project-field-label" htmlFor="wand-new-task-cwd">{isProject ? "项目目录" : "工作目录（可选）"}</label>
                <div className="wand-new-session-suggestions-wrap wand-new-project-suggestions-wrap">
                  <input
                    id="wand-new-task-cwd"
                    className="wand-new-session-input wand-new-project-input"
                    type="text"
                    value={cwd}
                    placeholder={isProject ? effectiveCwd : "留空则使用全局临时目录"}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-invalid={error.includes("目录") || undefined}
                    aria-describedby="wand-new-task-cwd-hint"
                    onFocus={() => setSuggestionsActive(true)}
                    onChange={(event) => setCwd(event.currentTarget.value)}
                    onBlur={() => window.setTimeout(() => setSuggestionsActive(false), 120)}
                  />
                  {suggestionsActive && suggestions.length > 0 ? (
                    <div className="wand-new-session-suggestions wand-new-project-suggestions" role="listbox" aria-label={isProject ? "项目目录建议" : "任务目录建议"}>
                      {suggestions.map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          className="wand-new-session-suggestion wand-new-project-suggestion"
                          role="option"
                          aria-selected={cwd === item.path}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setCwd(item.path);
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
                  {isProject
                    ? "项目必须在目录下执行，留空则使用当前目录。"
                    : "可选。挂载后任务在该目录运行，不挂载则使用全局临时目录。"}
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
                        onClick={() => setCwd(item.path)}
                      >
                        <span className="wand-new-session-recent-path-value wand-new-project-recent-path-value">{item.path}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}

            {isProject || !hasDirectory ? null : (
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
            )}

            {isProject ? null : (
              <WorkspaceAgentPicker
                target={target}
                kind={sessionKind}
                disabled={submitting}
                onTargetChange={setTarget}
                onKindChange={setSessionKind}
              />
            )}
          </div>

          <div className="wand-new-session-summary wand-new-task-summary" aria-live="polite">
            <span>即将创建</span>
            <strong>{name.trim() || (isProject ? "未命名项目" : "未命名任务")}</strong>
            <span title={effectiveCwd}>{effectiveCwd}</span>
            {isProject
              ? <span>空白项目</span>
              : <span>{target === "shell" ? "空白终端" : `${WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? target} · ${sessionKind === "pty" ? "PTY" : "结构化"}`}</span>}
          </div>

          <div className="wand-new-session-footer wand-new-project-footer">
            <WandButton
              kind="primary"
              size="large"
              type="submit"
              className="wand-new-session-submit wand-new-project-submit"
              disabled={submitting || !name.trim()}
            >
              {submitting ? "正在创建…" : isProject ? "创建项目" : "创建任务"}
            </WandButton>
            {error ? <p className="wand-new-session-error wand-new-project-error" role="alert">{error}</p> : null}
          </div>
        </form>
      )}
    </WandDialogSurface>
  );
}
