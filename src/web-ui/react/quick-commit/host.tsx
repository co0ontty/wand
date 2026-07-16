import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { WandButton, WandDialogSurface, WandSwitch } from "../ui";
import { quickCommitController, quickCommitStore } from "./controller";
import {
  buildQuickCommitInput,
  buildQuickCommitOutcome,
  hasQuickCommitChanges,
  QUICK_COMMIT_ACTIONS,
  quickCommitActionMeta,
  quickCommitStatusBadge,
} from "./model";
import { httpQuickCommitRepository } from "./repository";
import type {
  QuickCommitAction,
  QuickCommitForm,
  QuickCommitOutcome,
  QuickCommitRepository,
  QuickCommitStatus,
} from "./types";

export interface QuickCommitHostProps {
  repository?: QuickCommitRepository;
}

const EMPTY_FORM: QuickCommitForm = { message: "", tag: "", tagEdited: false };

function presentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === "Failed to fetch") return fallback;
  return error.message;
}

function statusDescription(status: QuickCommitStatus | null): string {
  if (!status) return "加载 Git 状态并准备提交。";
  const parts = [
    status.branch || "(no branch)",
    status.modifiedCount > 0 ? `${status.modifiedCount} 个改动` : "工作区干净",
  ];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(" · ");
}

function commitSummary(outcome: QuickCommitOutcome): string {
  const submodule = outcome.submoduleCount > 0
    ? `已先提交 ${outcome.submoduleCount} 个 submodule，`
    : "";
  const commit = outcome.commitHash ? ` ${outcome.commitHash}` : "";
  const tag = outcome.tagName ? `，已打 Tag ${outcome.tagName}` : "";
  return `${submodule}已提交${commit}${tag}`;
}

function CommitValue({ hash, subject, empty }: { hash: string; subject: string; empty: string }) {
  if (!hash) return <span className="wand-quick-muted">{empty}</span>;
  return (
    <span className="wand-quick-value-stack">
      <code>{hash}</code>
      {subject ? <span>{subject}</span> : null}
    </span>
  );
}

function ResultPair({
  label,
  before,
  after,
}: {
  label: string;
  before: React.ReactNode;
  after: React.ReactNode;
}) {
  return (
    <div className="wand-quick-result-pair">
      <span className="wand-quick-result-label">{label}</span>
      <div className="wand-quick-result-flow">
        <div>{before}</div>
        <span aria-hidden="true">→</span>
        <div>{after}</div>
      </div>
    </div>
  );
}

function ChangedFiles({ status }: { status: QuickCommitStatus }) {
  return (
    <section className="wand-quick-files" aria-labelledby="wand-quick-files-title">
      <div className="wand-quick-section-heading">
        <h3 id="wand-quick-files-title">改动文件</h3>
        <span>{status.modifiedCount}</span>
      </div>
      {status.files.length > 0 ? (
        <ul className="wand-quick-file-list">
          {status.files.map((file, index) => {
            const badge = quickCommitStatusBadge(file.status);
            const submoduleLabels = file.submoduleState
              ? [
                  file.submoduleState.commitChanged ? "新指针" : "",
                  file.submoduleState.hasTrackedChanges ? "dirty" : "",
                  file.submoduleState.hasUntracked ? "未跟踪" : "",
                ].filter(Boolean)
              : [];
            return (
              <li key={`${file.path}-${index}`} title={file.path}>
                <span
                  className={`wand-quick-file-badge wand-quick-file-badge-${badge.tone}`}
                  title={badge.label}
                  aria-label={badge.label}
                >
                  {badge.letter}
                </span>
                <span className="wand-quick-file-path">{file.path}</span>
                {file.isSubmodule ? (
                  <span className="wand-quick-submodule-badge">
                    submodule{submoduleLabels.length ? ` · ${submoduleLabels.join(" / ")}` : ""}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="wand-quick-empty">没有可提交的改动。</p>
      )}
    </section>
  );
}

export function QuickCommitHost({ repository = httpQuickCommitRepository }: QuickCommitHostProps) {
  const controller = useSyncExternalStore(
    quickCommitStore.subscribe,
    quickCommitStore.getSnapshot,
    quickCommitStore.getSnapshot,
  );
  const [status, setStatus] = useState<QuickCommitStatus | null>(null);
  const [form, setForm] = useState<QuickCommitForm>(EMPTY_FORM);
  const [action, setAction] = useState<QuickCommitAction>("commit");
  const [includeSubmodule, setIncludeSubmodule] = useState(false);
  const [outcome, setOutcome] = useState<QuickCommitOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState("");
  const [pushError, setPushError] = useState("");
  const generationAbort = useRef<AbortController | null>(null);
  const messageInput = useRef<HTMLTextAreaElement | null>(null);
  const context = controller.context;

  useEffect(() => {
    if (!controller.open || !context) return;
    const abort = new AbortController();
    generationAbort.current?.abort();
    generationAbort.current = null;
    setStatus(null);
    setForm(EMPTY_FORM);
    setAction("commit");
    setIncludeSubmodule(false);
    setOutcome(null);
    setLoading(true);
    setGenerating(false);
    setSubmitting(false);
    setPushing(false);
    setError("");
    setPushError("");
    void repository.loadStatus(context.sessionId, { signal: abort.signal })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setStatus(loaded);
        if (!loaded.isGit) setError(loaded.error || "当前目录不是 Git 仓库。");
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(presentError(loadError, "无法加载 Git 状态。"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      abort.abort();
      generationAbort.current?.abort();
      generationAbort.current = null;
    };
  }, [controller.open, controller.revision, context?.sessionId, repository]);

  useEffect(() => {
    if (!controller.open || loading || !status || outcome) return;
    const frame = window.requestAnimationFrame(() => messageInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [controller.open, loading, outcome, status]);

  const selectedMeta = useMemo(() => quickCommitActionMeta(action), [action]);
  const busy = submitting || pushing;
  const canCommit = hasQuickCommitChanges(status) && !busy && !loading;

  async function reloadStatus(sessionId: string): Promise<void> {
    quickCommitStore.getRuntime()?.onRepositoryChanged(sessionId);
    try {
      const loaded = await repository.loadStatus(sessionId);
      if (quickCommitStore.getSnapshot().context?.sessionId === sessionId) setStatus(loaded);
    } catch {
      // The operation already succeeded; a stale status panel is non-fatal.
    }
  }

  async function generateSuggestion(): Promise<void> {
    if (!context || generating || submitting) return;
    generationAbort.current?.abort();
    const abort = new AbortController();
    generationAbort.current = abort;
    setGenerating(true);
    setError("");
    try {
      const suggestion = await repository.generate(context.sessionId, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setForm((current) => ({
        message: current.message.trim() ? current.message : suggestion.message,
        tag: current.tagEdited ? current.tag : (suggestion.suggestedTag || current.tag),
        tagEdited: current.tagEdited,
      }));
      if (suggestion.suggestedTag) setAction("commit-tag");
    } catch (generateError) {
      if (!abort.signal.aborted) setError(presentError(generateError, "AI 生成失败。"));
    } finally {
      if (!abort.signal.aborted) setGenerating(false);
      if (generationAbort.current === abort) generationAbort.current = null;
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!context || !status || !canCommit) return;
    quickCommitController.setDismissable(false);
    setSubmitting(true);
    setError("");
    setPushError("");
    try {
      const response = await repository.commit(
        context.sessionId,
        buildQuickCommitInput(form, action, includeSubmodule),
      );
      if (!response.ok) throw new Error("快捷提交失败。");
      const nextOutcome = buildQuickCommitOutcome(
        action,
        includeSubmodule,
        form,
        status,
        response,
      );
      const summary = commitSummary(nextOutcome);
      if (selectedMeta.push && !response.pushError) {
        quickCommitStore.getRuntime()?.toast(`${summary}，已推送。`, "success");
        void reloadStatus(context.sessionId);
        quickCommitController.close();
        return;
      }
      setOutcome(nextOutcome);
      if (response.pushError) {
        setPushError(response.pushError);
        quickCommitStore.getRuntime()?.toast(`${summary}；push 失败：${response.pushError}`, "error");
      } else {
        quickCommitStore.getRuntime()?.toast(`${summary}。`, "success");
      }
      await reloadStatus(context.sessionId);
    } catch (commitError) {
      setError(presentError(commitError, "快捷提交失败。"));
    } finally {
      quickCommitController.setDismissable(true);
      setSubmitting(false);
    }
  }

  async function pushAndClose(): Promise<void> {
    if (!context || !outcome || pushing) return;
    quickCommitController.setDismissable(false);
    setPushing(true);
    setPushError("");
    try {
      const response = await repository.push(context.sessionId, {
        pushCommits: true,
        pushTags: !!outcome.tagName,
        submodule: outcome.includeSubmodule,
        tag: outcome.tagName,
      });
      if (!response.ok || response.error) {
        const message = response.error || "推送失败。";
        setPushError(message);
        quickCommitStore.getRuntime()?.toast(`推送失败：${message}`, "error");
        return;
      }
      const pushed = [response.pushedCommits ? "commits" : "", response.pushedTags ? "tags" : ""]
        .filter(Boolean)
        .join(" 和 ") || "（无内容）";
      quickCommitStore.getRuntime()?.toast(`已推送 ${pushed}`, "success");
      void reloadStatus(context.sessionId);
      quickCommitController.close();
    } catch (pushFailure) {
      const message = presentError(pushFailure, "推送失败。");
      setPushError(message);
      quickCommitStore.getRuntime()?.toast(message, "error");
    } finally {
      quickCommitController.setDismissable(true);
      setPushing(false);
    }
  }

  function submitShortcut(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  }

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) quickCommitController.close(); }}
      title="快捷提交"
      description={statusDescription(status)}
      className="wand-quick-dialog"
      overlayClassName="wand-quick-overlay"
      titleClassName="wand-quick-title"
      descriptionClassName="wand-quick-description"
      headerClassName="wand-quick-header"
      closeLabel="关闭快捷提交"
      testId="quick-commit-dialog"
      dismissable={!busy}
    >
      {loading ? (
        <div className="wand-quick-loading" role="status">正在加载 Git 状态…</div>
      ) : outcome ? (
        <section className="wand-quick-result" aria-label="提交结果">
          <ResultPair
            label="Commit"
            before={<CommitValue hash={outcome.oldCommitHash} subject={outcome.oldCommitSubject} empty="无" />}
            after={<CommitValue hash={outcome.commitHash} subject={outcome.commitMessage} empty="无" />}
          />
          <ResultPair
            label="Tag"
            before={outcome.oldTag ? <code>{outcome.oldTag}</code> : <span className="wand-quick-muted">无 tag</span>}
            after={outcome.tagName ? <code>{outcome.tagName}</code> : <span className="wand-quick-muted">未打 tag</span>}
          />
          {outcome.submoduleCount > 0 ? (
            <p className="wand-quick-result-note">已提交 {outcome.submoduleCount} 个 submodule。</p>
          ) : null}
          {outcome.pushError || pushError ? (
            <p className="wand-quick-error" role="alert">{pushError || outcome.pushError}</p>
          ) : null}
          <div className="wand-quick-result-actions">
            <WandButton kind="ghost" disabled={pushing} onClick={() => quickCommitController.close()}>
              关闭
            </WandButton>
            {outcome.pushed ? (
              <span className="wand-quick-pushed">已推送</span>
            ) : (
              <WandButton kind="primary" disabled={pushing} onClick={() => void pushAndClose()}>
                {pushing ? "推送中…" : "Push & Close"}
              </WandButton>
            )}
          </div>
        </section>
      ) : status ? (
        <form className="wand-quick-form" aria-busy={busy} onSubmit={(event) => void submit(event)}>
          <div className="wand-quick-body">
            <ChangedFiles status={status} />
            <section className="wand-quick-editor" aria-labelledby="wand-quick-editor-title">
              <div className="wand-quick-section-heading">
                <h3 id="wand-quick-editor-title">New</h3>
                <WandButton
                  kind="ghost"
                  size="small"
                  disabled={generating || submitting || !hasQuickCommitChanges(status)}
                  title="AI 生成 commit message 与 tag"
                  onClick={() => void generateSuggestion()}
                >
                  {generating ? "生成中…" : "✦ AI"}
                </WandButton>
              </div>
              <label className="wand-quick-field" htmlFor="wand-quick-message">
                <span>Commit message</span>
                <textarea
                  id="wand-quick-message"
                  ref={messageInput}
                  data-wand-autofocus=""
                  rows={3}
                  value={form.message}
                  disabled={submitting}
                  placeholder="留空则自动生成"
                  onChange={(event) => setForm({ ...form, message: event.currentTarget.value })}
                  onKeyDown={submitShortcut}
                />
              </label>
              <label className="wand-quick-field" htmlFor="wand-quick-tag">
                <span>版本 Tag</span>
                <input
                  id="wand-quick-tag"
                  type="text"
                  value={form.tag}
                  disabled={submitting}
                  placeholder="选择 Tag 动作时，留空则自动生成"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setForm({
                    ...form,
                    tag: event.currentTarget.value,
                    tagEdited: true,
                  })}
                />
              </label>
            </section>
            <fieldset className="wand-quick-actions">
              <legend>执行动作</legend>
              <div className="wand-quick-action-grid">
                {QUICK_COMMIT_ACTIONS.map((item) => (
                  <label
                    key={item.action}
                    className={action === item.action ? "is-selected" : undefined}
                  >
                    <input
                      type="radio"
                      name="wand-quick-action"
                      value={item.action}
                      checked={action === item.action}
                      disabled={!hasQuickCommitChanges(status) || busy}
                      onChange={() => setAction(item.action)}
                    />
                    <strong>{item.label}</strong>
                    <span>{item.verb}</span>
                  </label>
                ))}
              </div>
              {status.hasSubmodule ? (
                <div className="wand-quick-submodule-toggle">
                  <div>
                    <strong>包含 Submodule</strong>
                    <span>递归执行 commit、tag 和 push。</span>
                  </div>
                  <WandSwitch
                    id="wand-quick-submodule"
                    checked={includeSubmodule}
                    disabled={busy}
                    ariaLabel="包含 Submodule"
                    onCheckedChange={setIncludeSubmodule}
                  />
                </div>
              ) : null}
            </fieldset>
            {error ? <p className="wand-quick-error" role="alert">{error}</p> : null}
          </div>
          <footer className="wand-quick-footer">
            <span>{hasQuickCommitChanges(status) ? "⌘/Ctrl + Enter 快速执行" : "工作区干净，无可提交改动"}</span>
            <div>
              <WandButton kind="ghost" disabled={busy} onClick={() => quickCommitController.close()}>
                取消
              </WandButton>
              <WandButton kind="primary" type="submit" disabled={!canCommit}>
                {submitting
                  ? (form.message.trim() ? "执行中…" : "AI 生成 + 提交中…")
                  : selectedMeta.verb}
              </WandButton>
            </div>
          </footer>
        </form>
      ) : (
        <div className="wand-quick-loading">
          {error ? <p className="wand-quick-error" role="alert">{error}</p> : "没有可用的 Git 状态。"}
        </div>
      )}
    </WandDialogSurface>
  );
}
