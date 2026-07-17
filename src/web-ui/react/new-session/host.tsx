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
import { WandButton, WandDialogSurface, WandSwitch } from "../ui";
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

export interface NewSessionHostProps {
  repository?: NewSessionRepository;
}

const PROVIDERS: ReadonlyArray<{
  value: NewSessionProvider;
  label: string;
  description: string;
}> = [
  { value: "claude", label: "Claude", description: "完整 Claude 会话能力" },
  { value: "codex", label: "Codex", description: "结构化 JSONL 或 PTY 会话" },
  { value: "opencode", label: "OpenCode", description: "多模型结构化或 PTY 会话" },
  { value: "grok", label: "Grok", description: "Grok Build 结构化或 PTY 会话" },
];

const KINDS: ReadonlyArray<{
  value: NewSessionKind;
  label: string;
  description: string;
}> = [
  { value: "structured", label: "结构化", description: "智能对话模式" },
  { value: "pty", label: "PTY", description: "交互式终端会话" },
];

const MODES: ReadonlyArray<{
  value: NewSessionMode;
  label: string;
  description: string;
}> = [
  { value: "managed", label: "托管", description: "全自动完成任务" },
  { value: "full-access", label: "全权限", description: "自动确认权限" },
  { value: "auto-edit", label: "自动编辑", description: "自动确认修改" },
  { value: "default", label: "标准", description: "逐步确认操作" },
  { value: "native", label: "原生", description: "原生结构化输出" },
];

/** xAI 官方 Grok SVG（2025-02 版）的 `#mark` 原始路径。 */
function GrokMark() {
  return (
    <svg className="wand-provider-grok-mark" viewBox="0 0 34 33" aria-hidden="true" focusable="false">
      <path d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449.844576C33.5314.730667 33.6139.616757 33.6964.5L29.1113 5.09055V5.07631L13.2343 21.0436Z" />
      <path d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745.36364 32.5L10.9474 23.0341Z" />
    </svg>
  );
}

function kindHint(provider: NewSessionProvider, kind: NewSessionKind): string {
  if (kind === "structured") {
    if (provider === "codex") return "Codex JSONL 结构化聊天界面，支持多轮对话和工具调用展示。";
    if (provider === "opencode") return "OpenCode JSON 结构化聊天界面，支持续聊、思考过程和工具调用展示。";
    if (provider === "grok") return "Grok streaming-json 结构化聊天界面，支持多轮续聊与思考过程展示。";
    return "结构化聊天界面，支持多轮对话、流式输出和工具调用展示。";
  }
  if (provider === "codex") return "Codex PTY 终端会话；terminal 是原始输出，chat 是解析后的阅读视图。";
  if (provider === "opencode") return "OpenCode TUI 的原始 PTY 终端会话。";
  if (provider === "grok") return "Grok Build TUI 的原始 PTY 终端会话。";
  return "原始 PTY 终端会话，支持持续交互、终端视图和权限流。";
}

function modeHint(provider: NewSessionProvider, mode: NewSessionMode): string {
  if (provider === "codex") {
    return "Codex 支持 PTY 终端与结构化（JSONL）两种会话，结构化模式按 full-access 启动。";
  }
  if (provider === "opencode") {
    return mode === "full-access" || mode === "managed" || mode === "auto-edit"
      ? "OpenCode 将自动批准未显式拒绝的权限；支持 TUI 与 JSON 结构化会话。"
      : "OpenCode 使用自身权限配置；结构化模式会自动拒绝未批准的权限请求。";
  }
  if (provider === "grok") {
    return mode === "full-access" || mode === "managed"
      ? "Grok 将以 always-approve 运行；支持 TUI 与 streaming-json 结构化会话。"
      : "Grok 使用自身权限确认；支持 TUI 与 streaming-json 结构化会话。";
  }
  if (mode === "full-access") return "自动确认权限请求与高权限操作，适合你确认环境安全后的连续修改。";
  if (mode === "auto-edit") return "保留交互式会话，同时更偏向直接编辑代码。";
  if (mode === "native") return "调用 Claude 原生 API 输出，适合快速问答或一次性生成。";
  if (mode === "managed") return "AI 自动完成所有工作，无需中途确认，适合有明确目标的任务。";
  return "保留标准交互流程，适合手动确认每一步。";
}

function creationFallback(provider: NewSessionProvider, kind: NewSessionKind): string {
  if (kind === "structured") return "无法启动结构化会话，请确认对应 Provider 已正确安装。";
  if (provider === "codex") return "无法启动 Codex 会话，请确认 codex 已正确安装并可在终端中执行。";
  if (provider === "opencode") return "无法启动 OpenCode 会话，请确认 opencode-ai 已正确安装。";
  if (provider === "grok") return "无法启动 Grok 会话，请确认 Grok Build CLI 已正确安装。";
  return "无法启动 Claude 会话，请确认 Claude 已正确安装。";
}

function presentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === "Failed to fetch") return fallback;
  return error.message;
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
  const providerRefs = useRef<Partial<Record<NewSessionProvider, HTMLButtonElement | null>>>({});
  const kindRefs = useRef<Partial<Record<NewSessionKind, HTMLButtonElement | null>>>({});
  const modeRefs = useRef<Partial<Record<NewSessionMode, HTMLButtonElement | null>>>({});

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
    void repository.load({ signal: abort.signal })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        const context = runtime?.getContext();
        setDefaults(loaded);
        setForm({
          provider: loaded.config.defaultProvider,
          kind: loaded.config.defaultSessionKind,
          mode: safeMode(
            loaded.config.defaultProvider,
            loaded.config.defaultMode,
            loaded.config.defaultMode,
          ),
          cwd: "",
          worktreeEnabled: false,
        });
        if (!context) setError("新建会话运行环境尚未就绪，请刷新页面后重试。");
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(presentError(loadError, "无法加载新建会话配置。"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [controller.open, controller.revision, repository]);

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

  const selectProvider = useCallback((provider: NewSessionProvider) => {
    if (!defaults) return;
    setForm((current) => current ? {
      ...current,
      provider,
      mode: safeMode(provider, current.mode, defaults.config.defaultMode),
    } : current);
    const currentMode = form
      ? safeMode(provider, form.mode, defaults.config.defaultMode)
      : safeMode(provider, defaults.config.defaultMode, defaults.config.defaultMode);
    void repository.savePreferences({ defaultProvider: provider, defaultMode: currentMode })
      .catch((saveError) => console.warn("[wand] Failed to persist new-session defaults", saveError));
  }, [defaults, form, repository]);

  const selectKind = useCallback((kind: NewSessionKind) => {
    setForm((current) => current ? { ...current, kind } : current);
    void repository.savePreferences({ defaultSessionKind: kind })
      .catch((saveError) => console.warn("[wand] Failed to persist new-session defaults", saveError));
  }, [repository]);

  const selectMode = useCallback((mode: NewSessionMode) => {
    if (!form || !supportedModes(form.provider).includes(mode)) return;
    setForm((current) => current ? { ...current, mode } : current);
    void repository.savePreferences({ defaultMode: mode })
      .catch((saveError) => console.warn("[wand] Failed to persist new-session defaults", saveError));
  }, [form, repository]);

  const supported = useMemo(
    () => new Set(form ? supportedModes(form.provider) : []),
    [form?.provider],
  );

  function navigateChoice<T extends string>(
    event: KeyboardEvent<HTMLButtonElement>,
    current: T,
    values: readonly T[],
    choose: (value: T) => void,
    refs: MutableRefObject<Partial<Record<T, HTMLButtonElement | null>>>,
  ): void {
    if (!RADIO_NAVIGATION_KEYS.has(event.key as ChoiceNavigationKey)) return;
    event.preventDefault();
    const next = nextChoice(values, current, event.key as ChoiceNavigationKey);
    choose(next);
    window.requestAnimationFrame(() => refs.current[next]?.focus());
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
      const dimensions = await runtime.prepareCreate(form.kind);
      const request = buildCreateRequest(form, defaults.config, runtime.getContext(), dimensions);
      void repository.savePreferences({
        defaultProvider: request.provider,
        defaultSessionKind: request.kind,
        defaultMode: request.mode,
      }).catch((saveError) => console.warn("[wand] Failed to persist new-session defaults", saveError));
      const created = await repository.create(request);
      await runtime.completeCreate(request, created);
      newSessionController.close();
    } catch (createError) {
      setError(presentError(createError, creationFallback(form.provider, form.kind)));
    } finally {
      newSessionController.setDismissable(true);
      setSubmitting(false);
    }
  }

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) newSessionController.close(); }}
      title="新对话"
      description="启动 Claude、Codex、OpenCode 或 Grok 会话，选择 provider、会话类型、模式和工作目录。"
      className="wand-new-session-dialog"
      overlayClassName="wand-new-session-overlay"
      titleClassName="wand-new-session-title"
      descriptionClassName="wand-new-session-description"
      headerClassName="wand-new-session-header"
      closeLabel="关闭新建会话"
      testId="new-session-dialog"
      dismissable={!submitting}
    >
      {loading ? (
        <div className="wand-new-session-loading" role="status">正在加载新建会话配置…</div>
      ) : form && defaults ? (
        <form className="wand-new-session-form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <div className="wand-new-session-body">
            <fieldset className="wand-new-session-field wand-new-session-fieldset">
              <legend className="wand-new-session-field-label">Provider</legend>
              <div className="wand-new-session-choices" role="radiogroup" aria-label="Provider">
                {PROVIDERS.map((provider) => (
                  <button
                    key={provider.value}
                    type="button"
                    role="radio"
                    aria-checked={form.provider === provider.value}
                    tabIndex={form.provider === provider.value ? 0 : -1}
                    ref={(element) => { providerRefs.current[provider.value] = element; }}
                    className={`wand-new-session-choice wand-new-session-provider-choice${form.provider === provider.value ? " active" : ""}`}
                    autoFocus={form.provider === provider.value}
                    data-wand-autofocus={form.provider === provider.value ? "" : undefined}
                    onClick={() => selectProvider(provider.value)}
                    onKeyDown={(event) => navigateChoice(
                      event,
                      form.provider,
                      PROVIDERS.map((item) => item.value),
                      selectProvider,
                      providerRefs,
                    )}
                  >
                    {provider.value === "grok" && <GrokMark />}
                    <span className="wand-new-session-choice-label">{provider.label}</span>
                    <span className="wand-new-session-choice-description">{provider.description}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="wand-new-session-field wand-new-session-fieldset">
              <legend className="wand-new-session-field-label">会话类型</legend>
              <div className="wand-new-session-choices" role="radiogroup" aria-label="会话类型">
                {KINDS.map((kind) => (
                  <button
                    key={kind.value}
                    type="button"
                    role="radio"
                    aria-checked={form.kind === kind.value}
                    tabIndex={form.kind === kind.value ? 0 : -1}
                    ref={(element) => { kindRefs.current[kind.value] = element; }}
                    className={`wand-new-session-choice wand-new-session-kind-choice${form.kind === kind.value ? " active" : ""}`}
                    onClick={() => selectKind(kind.value)}
                    onKeyDown={(event) => navigateChoice(
                      event,
                      form.kind,
                      KINDS.map((item) => item.value),
                      selectKind,
                      kindRefs,
                    )}
                  >
                    <span className="wand-new-session-choice-label">{kind.label}</span>
                    <span className="wand-new-session-choice-description">{kind.description}</span>
                  </button>
                ))}
              </div>
              <p className="wand-new-session-field-hint">{kindHint(form.provider, form.kind)}</p>
              <div className="wand-new-session-worktree">
                <div>
                  <strong>Worktree 模式</strong>
                  <span>为本次会话创建独立的 Git worktree 与分支。</span>
                </div>
                <WandSwitch
                  id="wand-new-session-worktree"
                  checked={form.worktreeEnabled}
                  ariaLabel="启用 Worktree 模式"
                  onCheckedChange={(worktreeEnabled) => setForm({ ...form, worktreeEnabled })}
                />
              </div>
            </fieldset>

            <div className="wand-new-session-field">
              <label className="wand-new-session-field-label" htmlFor="wand-new-session-cwd">工作目录</label>
              <div className="wand-new-session-suggestions-wrap">
                <input
                  id="wand-new-session-cwd"
                  className="wand-new-session-input"
                  type="text"
                  value={form.cwd}
                  placeholder={newSessionStore.getRuntime()?.getContext().effectiveCwd || defaults.config.defaultCwd}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onFocus={() => setSuggestionsActive(true)}
                  onChange={(event) => setForm({ ...form, cwd: event.currentTarget.value })}
                  onBlur={() => window.setTimeout(() => setSuggestionsActive(false), 120)}
                />
                {suggestionsActive && suggestions.length > 0 ? (
                  <div className="wand-new-session-suggestions" role="listbox" aria-label="工作目录建议">
                    {suggestions.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        className="wand-new-session-suggestion"
                        role="option"
                        aria-selected={form.cwd === item.path}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setForm({ ...form, cwd: item.path });
                          setSuggestionsActive(false);
                        }}
                      >
                        <strong>{item.name}</strong>
                        <small className="wand-new-session-suggestion-path">{item.path}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <p className="wand-new-session-field-hint">创建前先确认目录；留空则使用上方目录，支持路径自动补全。</p>
              {defaults.recentPaths.length > 0 ? (
                <div className="wand-new-session-recent-paths" aria-label="最近使用的工作目录">
                  {defaults.recentPaths.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className="wand-new-session-recent-path"
                      title={item.path}
                      onClick={() => setForm({ ...form, cwd: item.path })}
                    >
                      <span className="wand-new-session-recent-path-value">{item.path}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <fieldset className="wand-new-session-field wand-new-session-fieldset">
              <legend className="wand-new-session-field-label">模式</legend>
              <div className="wand-new-session-choices" role="radiogroup" aria-label="执行模式">
                {MODES.map((mode) => {
                  const disabled = !supported.has(mode.value);
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      role="radio"
                      aria-checked={form.mode === mode.value}
                      aria-disabled={disabled}
                      tabIndex={form.mode === mode.value ? 0 : -1}
                      ref={(element) => { modeRefs.current[mode.value] = element; }}
                      disabled={disabled}
                      className={`wand-new-session-choice${form.mode === mode.value ? " active" : ""}${disabled ? " disabled" : ""}`}
                      onClick={() => selectMode(mode.value)}
                      onKeyDown={(event) => navigateChoice(
                        event,
                        form.mode,
                        MODES.filter((item) => supported.has(item.value)).map((item) => item.value),
                        selectMode,
                        modeRefs,
                      )}
                    >
                      <span className="wand-new-session-choice-label">{mode.label}</span>
                      <span className="wand-new-session-choice-description">{mode.description}</span>
                    </button>
                  );
                })}
              </div>
              <p className="wand-new-session-field-hint">{modeHint(form.provider, form.mode)}</p>
            </fieldset>
          </div>

          <div className="wand-new-session-footer">
            <WandButton
              kind="primary"
              size="large"
              type="submit"
              className="wand-new-session-submit"
              disabled={submitting}
            >
              {submitting ? "正在启动…" : "启动会话"}
            </WandButton>
            {error ? <p className="wand-new-session-error" role="alert">{error}</p> : null}
          </div>
        </form>
      ) : error ? (
        <div className="wand-new-session-load-error" role="alert">
          <p>{error}</p>
          <WandButton kind="primary" onClick={() => newSessionController.open()}>重试</WandButton>
        </div>
      ) : null}
    </WandDialogSurface>
  );
}
