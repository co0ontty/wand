// 「新建任务」对话框。任务是一级容器：起名 + 选目录（目录级归属）+ 可选独立
// worktree。提交时按目录 find-or-create 隐式项目，再在该项目下建任务并直接打开，
// 之后在任务里新建会话不再需要选目录。

import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";

import { WandButton, WandDialogSurface, WandIcon, WandSwitch } from "../ui";
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
  WorkspaceTaskDetail,
  WorkspacesRepository,
} from "./types";

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

function directoryName(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) || cwd;
}



export function WorkspacesHost({ repository = httpWorkspacesRepository }: WorkspacesHostProps) {
  const controller = useSyncExternalStore(
    workspacesStore.subscribe,
    workspacesStore.getSnapshot,
    workspacesStore.getSnapshot,
  );
  const [defaults, setDefaults] = useState<NewProjectDefaults | null>(null);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [worktreeEnabled, setWorktreeEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<RecentPath[]>([]);
  const [suggestionsActive, setSuggestionsActive] = useState(false);

  // 打开对话框时加载默认值
  useEffect(() => {
    if (!controller.open) return;
    const abort = new AbortController();
    setLoading(true);
    setSubmitting(false);
    setError("");
    setDefaults(null);
    setName("");
    setWorktreeEnabled(true);
    setCwd(controller.initialCwd);
    setSuggestions([]);
    setSuggestionsActive(false);
    void loadNewProjectDefaults(undefined, { signal: abort.signal })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setDefaults(loaded);
        setCwd((current) => current || loaded.defaultCwd || workspacesStore.getRuntime()?.effectiveCwd() || "");
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(presentError(loadError, "无法加载新建任务配置。"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [controller.initialCwd, controller.open, controller.revision]);

  // 目录输入防抖补全
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
  }, [controller.open, cwd]);

  const effectiveCwd = cwd.trim()
    || workspacesStore.getRuntime()?.effectiveCwd()
    || defaults?.defaultCwd
    || "当前工作目录";

  /** 目录级归属：同一目录复用既有项目，没有就按目录名隐式创建一个。 */
  const findOrCreateWorkspace = async (dir: string): Promise<Workspace> => {
    const normalized = normalizeDir(dir);
    const existing = await repository.list();
    const match = existing.find((workspace) => normalizeDir(workspace.cwd) === normalized);
    if (match) return match;
    return repository.create({ name: directoryName(normalized), cwd: dir.trim() });
  };

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
      setError("请输入任务名称。");
      return;
    }
    const trimmedCwd = cwd.trim() || runtime.effectiveCwd();
    if (!trimmedCwd) {
      setError("请选择任务目录。");
      return;
    }
    workspacesController.setDismissable(false);
    setSubmitting(true);
    setError("");
    try {
      const workspace = await findOrCreateWorkspace(trimmedCwd);
      const created: WorkspaceTaskDetail = await repository.createTask(workspace.id, {
        name: trimmedName,
        worktree: worktreeEnabled,
      });
      const payload: OpenWorkspaceTaskPayload = {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: created.id,
        taskName: created.name,
        cwd: created.cwd || created.worktree?.path || workspace.cwd,
      };
      if (workspace.defaultProvider) payload.provider = workspace.defaultProvider;
      runtime.openTask(payload);
      void runtime.refreshSessions();
      if (!created.isolated && created.worktreeError) {
        runtime.toast(created.worktreeError, "warning");
      } else {
        runtime.toast(
          `已创建任务「${created.name}」${created.isolated ? "（独立 worktree）" : ""}`,
          "success",
        );
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
      description="任务归属所选目录；之后在任务里新建会话无需再选目录。可选独立 worktree 隔离改动。"
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
        <div className="wand-new-session-loading wand-new-project-loading" role="status">正在加载新建任务配置…</div>
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
              <p id="wand-new-task-name-hint" className="wand-new-session-field-hint wand-new-project-field-hint">用于在任务列表里识别这个任务。</p>
            </div>

            <div className="wand-new-session-field wand-new-project-field">
              <label className="wand-new-session-field-label wand-new-project-field-label" htmlFor="wand-new-task-cwd">任务目录</label>
              <div className="wand-new-session-suggestions-wrap wand-new-project-suggestions-wrap">
                <input
                  id="wand-new-task-cwd"
                  className="wand-new-session-input wand-new-project-input"
                  type="text"
                  value={cwd}
                  placeholder={effectiveCwd}
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
              <p id="wand-new-task-cwd-hint" className="wand-new-session-field-hint wand-new-project-field-hint">任务锚定的目录，留空则使用当前目录。</p>
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
                onCheckedChange={setWorktreeEnabled}
                ariaLabel="是否为新任务创建独立 worktree"
              />
            </div>
          </div>

          <div className="wand-new-session-summary wand-new-task-summary" aria-live="polite">
            <span>即将创建</span>
            <strong>{name.trim() || "未命名任务"}</strong>
            <span title={effectiveCwd}>{effectiveCwd}</span>
            <span>{worktreeEnabled ? "独立 worktree" : "共享目录"}</span>
          </div>

          <div className="wand-new-session-footer wand-new-project-footer">
            <WandButton
              kind="primary"
              size="large"
              type="submit"
              className="wand-new-session-submit wand-new-project-submit"
              disabled={submitting || !name.trim()}
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
