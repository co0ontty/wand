import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";

import { ProviderLogo } from "../provider-logo";
import { WandButton, WandDialogSurface } from "../ui";
import { workspacesController, workspacesStore } from "./controller";
import {
  httpWorkspacesRepository,
  loadNewProjectDefaults,
  suggestWorkspacePaths,
} from "./repository";
import type {
  NewProjectDefaults,
  RecentPath,
  Workspace,
  WorkspaceProvider,
  WorkspacesRepository,
} from "./types";

export interface WorkspacesHostProps {
  repository?: WorkspacesRepository;
}

const PROVIDERS: ReadonlyArray<{ value: WorkspaceProvider; label: string; description: string }> = [
  { value: "claude", label: "Claude", description: "完整 Claude 会话能力" },
  { value: "codex", label: "Codex", description: "结构化 JSONL 或 PTY 会话" },
  { value: "opencode", label: "OpenCode", description: "多模型结构化或 PTY 会话" },
  { value: "grok", label: "Grok", description: "Grok Build 结构化或 PTY 会话" },
  { value: "qoder", label: "Qoder", description: "Qoder CLI 结构化或 PTY 会话" },
  { value: "pi", label: "Pi", description: "Pi 多模型结构化或 PTY 会话" },
];

function presentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === "Failed to fetch") return fallback;
  return error.message;
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
  const [provider, setProvider] = useState<WorkspaceProvider>("claude");
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
    setCwd(controller.initialCwd);
    setSuggestions([]);
    setSuggestionsActive(false);
    void loadNewProjectDefaults(undefined, { signal: abort.signal })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setDefaults(loaded);
        setProvider(loaded.defaultProvider);
        setCwd((current) => current || loaded.defaultCwd || workspacesStore.getRuntime()?.effectiveCwd() || "");
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(presentError(loadError, "无法加载新建项目配置。"));
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
  }, [controller.open, cwd, suggestionsActive]);

  const effectiveCwd = cwd.trim()
    || workspacesStore.getRuntime()?.effectiveCwd()
    || defaults?.defaultCwd
    || "当前工作目录";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const runtime = workspacesStore.getRuntime();
    if (!runtime) {
      setError("新建项目运行环境尚未就绪，请刷新页面后重试。");
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("请输入项目名称。");
      return;
    }
    const trimmedCwd = cwd.trim() || runtime.effectiveCwd();
    if (!trimmedCwd) {
      setError("请选择项目目录。");
      return;
    }
    workspacesController.setDismissable(false);
    setSubmitting(true);
    setError("");
    try {
      const created: Workspace = await repository.create({
        name: trimmedName,
        cwd: trimmedCwd,
        defaultProvider: provider,
      });
      runtime.openWorkspace(created);
      runtime.toast(`已创建项目「${created.name}」`, "success");
      workspacesController.close();
    } catch (createError) {
      setError(presentError(createError, "创建项目失败，请检查目录是否有效。"));
    } finally {
      workspacesController.setDismissable(true);
      setSubmitting(false);
    }
  }

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) workspacesController.close(); }}
      title="新建项目"
      description="起一个项目名、选择目录与默认 IDE。项目不会自动启动任何会话，稍后在标签里按需添加。"
      className="wand-new-session-dialog wand-new-project-dialog"
      overlayClassName="wand-new-session-overlay wand-new-project-overlay"
      titleClassName="wand-new-session-title wand-new-project-title"
      descriptionClassName="wand-new-session-description wand-new-project-description"
      headerClassName="wand-new-session-header wand-new-project-header"
      closeLabel="关闭新建项目"
      testId="new-project-dialog"
      dismissable={!submitting}
    >
      {loading ? (
        <div className="wand-new-session-loading wand-new-project-loading" role="status">正在加载新建项目配置…</div>
      ) : (
        <form className="wand-new-session-form wand-new-project-form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <div className="wand-new-session-body wand-new-project-body">
            <div className="wand-new-session-field wand-new-project-field">
              <label className="wand-new-session-field-label wand-new-project-field-label" htmlFor="wand-new-project-name">项目名称</label>
              <input
                id="wand-new-project-name"
                className="wand-new-session-input wand-new-project-input"
                type="text"
                value={name}
                placeholder="例如：我的应用"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-wand-autofocus=""
                aria-describedby="wand-new-project-name-hint"
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <p id="wand-new-project-name-hint" className="wand-new-session-field-hint wand-new-project-field-hint">用于在工作空间列表里识别这个项目。</p>
            </div>

            <div className="wand-new-session-field wand-new-project-field">
              <label className="wand-new-session-field-label wand-new-project-field-label" htmlFor="wand-new-project-cwd">项目目录</label>
              <div className="wand-new-session-suggestions-wrap wand-new-project-suggestions-wrap">
                <input
                  id="wand-new-project-cwd"
                  className="wand-new-session-input wand-new-project-input"
                  type="text"
                  value={cwd}
                  placeholder={effectiveCwd}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-invalid={error.includes("目录") || undefined}
                  aria-describedby="wand-new-project-cwd-hint"
                  onFocus={() => setSuggestionsActive(true)}
                  onChange={(event) => setCwd(event.currentTarget.value)}
                  onBlur={() => window.setTimeout(() => setSuggestionsActive(false), 120)}
                />
                {suggestionsActive && suggestions.length > 0 ? (
                  <div className="wand-new-session-suggestions wand-new-project-suggestions" role="listbox" aria-label="项目目录建议">
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
              <p id="wand-new-project-cwd-hint" className="wand-new-session-field-hint wand-new-project-field-hint">项目锚定的目录，留空则使用当前目录。</p>
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

            <fieldset className="wand-new-session-field wand-new-session-fieldset wand-new-project-field wand-new-project-fieldset">
              <legend className="wand-new-session-field-label wand-new-project-field-label">默认 IDE</legend>
              <div className="wand-new-session-choices wand-new-project-providers" role="radiogroup" aria-label="默认 IDE">
                {PROVIDERS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={provider === option.value}
                    tabIndex={provider === option.value ? 0 : -1}
                    className={`wand-new-session-choice wand-new-session-provider-choice wand-new-project-provider${provider === option.value ? " active" : ""}`}
                    onClick={() => setProvider(option.value)}
                  >
                    <ProviderLogo provider={option.value} className="wand-new-session-provider-logo wand-new-project-provider-logo" />
                    <span className="wand-new-session-choice-label wand-new-project-provider-label">{option.label}</span>
                    <span className="wand-new-session-choice-description wand-new-project-provider-description">{option.description}</span>
                  </button>
                ))}
              </div>
              <p className="wand-new-session-field-hint wand-new-project-field-hint">之后在项目里「+」新增标签时会默认用这个 IDE，可在标签里单独切换。</p>
            </fieldset>
          </div>

          <div className="wand-new-session-footer wand-new-project-footer">
            <WandButton
              kind="primary"
              size="large"
              type="submit"
              className="wand-new-session-submit wand-new-project-submit"
              disabled={submitting || !name.trim()}
            >
              {submitting ? "正在创建…" : "创建项目"}
            </WandButton>
            {error ? <p className="wand-new-session-error wand-new-project-error" role="alert">{error}</p> : null}
          </div>
        </form>
      )}
    </WandDialogSurface>
  );
}
