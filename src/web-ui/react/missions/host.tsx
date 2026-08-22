import { type FormEvent, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { ProviderLogo } from "../provider-logo";
import { WandButton, WandDialogSurface } from "../ui";
import { missionsController, missionsStore } from "./controller";
import { httpMissionsRepository } from "./repository";
import type {
  InboxItem,
  MissionAttempt,
  MissionDetails,
  MissionDiff,
  MissionProvider,
  MissionsRepository,
} from "./types";

const PROVIDERS: Array<{ id: MissionProvider; label: string }> = [
  { id: "claude", label: "Claude" }, { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" }, { id: "grok", label: "Grok" },
  { id: "qoder", label: "Qoder" }, { id: "pi", label: "Pi" },
];

const STATE_LABELS: Record<string, string> = {
  dispatching: "分派中", queued: "等待中", running: "执行中", working: "执行中",
  needs_input: "等待答复", needs_permission: "等待授权", completed: "已完成",
  done: "已完成", failed: "失败",
};

interface DiffLine {
  key: string;
  text: string;
  path: string | null;
  line: number | null;
  side: "old" | "new";
  kind: "add" | "remove" | "context" | "meta";
}

function parseDiff(patch: string): DiffLine[] {
  let oldFile: string | null = null;
  let newFile: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  return patch.split("\n").slice(0, 5000).map((text, index) => {
    if (text.startsWith("--- ")) {
      const path = text.slice(4).replace(/^a\//, "");
      oldFile = path === "/dev/null" ? null : path;
    }
    if (text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/^b\//, "");
      newFile = path === "/dev/null" ? null : path;
    }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { key: String(index), text, path: newFile ?? oldFile, line: null, side: "new", kind: "meta" };
    }
    if (text.startsWith("+") && !text.startsWith("+++")) {
      const line = newLine++;
      return { key: String(index), text, path: newFile ?? oldFile, line, side: "new", kind: "add" };
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      const line = oldLine++;
      return { key: String(index), text, path: oldFile ?? newFile, line, side: "old", kind: "remove" };
    }
    if (text.startsWith(" ")) {
      const line = newLine++;
      oldLine++;
      return { key: String(index), text, path: newFile ?? oldFile, line, side: "new", kind: "context" };
    }
    return { key: String(index), text, path: newFile ?? oldFile, line: null, side: "new", kind: "meta" };
  });
}

function splitPaths(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function AttemptCard({ attempt, onOpen, onDiff }: {
  attempt: MissionAttempt;
  onOpen(): void;
  onDiff(): void;
}) {
  return (
    <article className="wand-missions-attempt">
      <div className="wand-missions-attempt-head">
        <span className="wand-missions-provider"><ProviderLogo provider={attempt.provider}/><strong>{attempt.provider}</strong></span>
        <span className={`wand-missions-state is-${attempt.state}`}>{STATE_LABELS[attempt.state]}</span>
      </div>
      <p>{attempt.summary || attempt.error || attempt.branch || "正在准备独立 worktree…"}</p>
      <div className="wand-missions-attempt-actions">
        <WandButton size="small" kind="ghost" disabled={!attempt.sessionId} onClick={onOpen}>打开会话</WandButton>
        <WandButton size="small" kind="outline" disabled={!attempt.worktreePath} onClick={onDiff}>审查 Diff</WandButton>
      </div>
    </article>
  );
}

export function MissionsHost({ repository = httpMissionsRepository }: { repository?: MissionsRepository }) {
  const controller = useSyncExternalStore(missionsStore.subscribe, missionsStore.getSnapshot, missionsStore.getSnapshot);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [missions, setMissions] = useState<MissionDetails[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [sharedPaths, setSharedPaths] = useState("");
  const [copyPaths, setCopyPaths] = useState("");
  const [providers, setProviders] = useState<Set<MissionProvider>>(new Set(["claude", "codex"]));
  const [diff, setDiff] = useState<MissionDiff | null>(null);
  const [diffAttempt, setDiffAttempt] = useState<MissionAttempt | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{ filePath: string; line: number | null; side: "old" | "new" } | null>(null);
  const [reviewBody, setReviewBody] = useState("");

  const selected = missions.find((mission) => mission.id === selectedId) ?? missions[0] ?? null;
  const diffLines = useMemo(() => diff ? parseDiff(diff.patch) : [], [diff]);

  const refresh = async () => {
    const [nextMissions, nextInbox] = await Promise.all([
      repository.list(),
      repository.listInbox().catch(() => [] as InboxItem[]),
    ]);
    setMissions(nextMissions);
    setInbox(nextInbox);
    setSelectedId((current) => current && nextMissions.some((mission) => mission.id === current) ? current : nextMissions[0]?.id ?? null);
  };

  useEffect(() => {
    if (!controller.open) return;
    setCwd((value) => value || missionsStore.getRuntime()?.effectiveCwd() || "");
    setError("");
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "无法加载任务。"));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [controller.open, controller.revision]);

  const openSession = (sessionId: string) => {
    void missionsStore.getRuntime()?.openSession(sessionId);
    missionsController.close();
  };

  const submitMission = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const created = await repository.create({
        title: title.trim() || undefined, prompt, cwd, providers: [...providers],
        baseRef: baseRef.trim() || undefined,
        sharedDirectories: splitPaths(sharedPaths), copyPaths: splitPaths(copyPaths),
      });
      setCreating(false); setPrompt(""); setTitle(""); setSelectedId(created.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建任务失败。");
    } finally { setBusy(false); }
  };

  const openDiff = async (mission: MissionDetails, attempt: MissionAttempt) => {
    setBusy(true); setError("");
    try {
      setDiff(await repository.diff(mission.id, attempt.id));
      setDiffAttempt(attempt);
      setReviewTarget(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取 Diff。"); }
    finally { setBusy(false); }
  };

  const addComment = async () => {
    if (!selected || !diffAttempt || !reviewTarget || !reviewBody.trim()) return;
    setBusy(true); setError("");
    try {
      await repository.addComment(selected.id, diffAttempt.id, { ...reviewTarget, body: reviewBody });
      setReviewBody("");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存 Review。" ); }
    finally { setBusy(false); }
  };

  const sendReview = async () => {
    if (!selected || !diffAttempt) return;
    setBusy(true); setError("");
    try { await repository.sendReview(selected.id, diffAttempt.id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法发送 Review。" ); }
    finally { setBusy(false); }
  };

  const pendingComments = selected && diffAttempt
    ? selected.comments.filter((comment) => comment.attemptId === diffAttempt.id && comment.status === "pending")
    : [];

  return (
    <WandDialogSurface
      open={controller.open}
      title="并行任务"
      description="把同一个目标分派给多个 Agent，在独立 worktree 中并行尝试，并审查 Diff。"
      className="wand-missions-dialog"
      overlayClassName="wand-missions-overlay"
      headerClassName="wand-missions-header"
      titleClassName="wand-missions-title"
      descriptionClassName="wand-missions-description"
      onOpenChange={(open) => { if (!open) missionsController.close(); }}
    >
      <div className="wand-missions-toolbar">
        <span className="wand-missions-toolbar-note">{missions.length} 个任务</span>
        <WandButton kind="primary" size="small" onClick={() => setCreating(true)}>＋ 新任务</WandButton>
      </div>

      {error ? <div className="wand-missions-error" role="alert">{error}</div> : null}

      <div className="wand-missions-body">
        <div className="wand-missions-workspace">
          <aside className="wand-missions-list">
            {inbox.length ? (
              <div className="wand-missions-inbox">
                <strong>收件箱</strong>
                {inbox.map((item) => (
                  <button
                    key={item.sessionId}
                    type="button"
                    onClick={() => {
                      void repository.markInboxRead(item.sessionId).catch(() => undefined);
                      if (item.sessionId) void openSession(item.sessionId);
                    }}
                  >
                    <strong>{item.title}</strong>
                    <small>{STATE_LABELS[item.state] || item.state}{item.summary ? ` · ${item.summary}` : ""}</small>
                  </button>
                ))}
              </div>
            ) : null}
            {missions.map((mission) => (
              <button key={mission.id} className={selected?.id === mission.id ? "active" : ""} onClick={() => { setSelectedId(mission.id); setDiff(null); }}>
                <strong>{mission.title}</strong>
                <small>{mission.attempts.length} 个 Agent · {STATE_LABELS[mission.status]}</small>
              </button>
            ))}
            {!missions.length ? <div className="wand-missions-empty">创建一个任务，让多个 Agent 在独立 worktree 中并行尝试。</div> : null}
          </aside>
          <main className="wand-missions-detail">
            {selected ? (
              <>
                <div className="wand-missions-detail-head">
                  <div><h2>{selected.title}</h2><p>{selected.cwd} · 基线 {selected.worktree.baseRef || "当前分支"}</p></div>
                  <span className={`wand-missions-state is-${selected.status}`}>{STATE_LABELS[selected.status]}</span>
                </div>
                <p className="wand-missions-prompt">{selected.prompt}</p>
                <div className="wand-missions-attempt-grid">
                  {selected.attempts.map((attempt) => (
                    <AttemptCard key={attempt.id} attempt={attempt} onOpen={() => attempt.sessionId && openSession(attempt.sessionId)} onDiff={() => void openDiff(selected, attempt)}/>
                  ))}
                </div>
                {diff && diffAttempt ? (
                  <section className="wand-missions-review">
                    <div className="wand-missions-review-head">
                      <div><h3>{diffAttempt.provider} Diff</h3><span>{diff.files.length} 个文件{diff.truncated ? " · 内容已截断" : ""}</span></div>
                      <WandButton size="small" kind="ghost" onClick={() => setDiff(null)}>收起</WandButton>
                    </div>
                    <div className="wand-missions-diff" role="list" aria-label="任务 Diff">
                      {diffLines.map((line) => (
                        <button
                          key={line.key}
                          className={`is-${line.kind}`}
                          disabled={!line.path || line.line === null}
                          title={line.path && line.line ? `在 ${line.path}:${line.line} 添加意见` : undefined}
                          onClick={() => line.path && setReviewTarget({ filePath: line.path, line: line.line, side: line.side })}
                        >
                          <span>{line.line ?? ""}</span><code>{line.text || " "}</code>
                        </button>
                      ))}
                    </div>
                    {reviewTarget ? (
                      <div className="wand-missions-comment-form">
                        <label>{reviewTarget.filePath}{reviewTarget.line ? `:${reviewTarget.line}` : ""}</label>
                        <textarea value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} placeholder="写下具体、可执行的修改意见…"/>
                        <WandButton kind="primary" size="small" disabled={busy || !reviewBody.trim()} onClick={() => void addComment()}>加入 Review</WandButton>
                      </div>
                    ) : null}
                    {pendingComments.length ? (
                      <div className="wand-missions-pending-review">
                        <div>{pendingComments.map((comment) => <p key={comment.id}><strong>{comment.filePath}{comment.line ? `:${comment.line}` : ""}</strong>{comment.body}</p>)}</div>
                        <WandButton kind="primary" disabled={busy} onClick={() => void sendReview()}>发送 {pendingComments.length} 条意见</WandButton>
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : <div className="wand-missions-empty">选择或创建一个任务。</div>}
          </main>
        </div>
      </div>

      {creating ? (
        <div className="wand-missions-create-overlay">
          <form className="wand-missions-create" onSubmit={(event) => void submitMission(event)}>
            <div className="wand-missions-create-head"><div><h2>并行任务</h2><p>每个 Provider 会获得独立 branch 与 worktree。</p></div><button type="button" onClick={() => setCreating(false)}>×</button></div>
            <label>任务标题（可选）<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：重构会话恢复流程"/></label>
            <label>目标<textarea autoFocus required value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述清楚完成条件、限制和验证要求…"/></label>
            <label>项目目录<input required value={cwd} onChange={(event) => setCwd(event.target.value)}/></label>
            <div className="wand-missions-provider-picker">
              {PROVIDERS.map((provider) => (
                <label key={provider.id} className={providers.has(provider.id) ? "active" : ""}>
                  <input type="checkbox" checked={providers.has(provider.id)} onChange={() => setProviders((current) => {
                    const next = new Set(current); if (next.has(provider.id)) next.delete(provider.id); else next.add(provider.id); return next;
                  })}/><ProviderLogo provider={provider.id}/><span>{provider.label}</span>
                </label>
              ))}
            </div>
            <details><summary>Worktree 高级选项</summary>
              <label>基线 ref<input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="当前分支"/></label>
              <label>共享目录（仅 gitignored）<input value={sharedPaths} onChange={(event) => setSharedPaths(event.target.value)} placeholder="node_modules, .venv"/></label>
              <label>复制路径（仅 gitignored）<input value={copyPaths} onChange={(event) => setCopyPaths(event.target.value)} placeholder=".env.local"/></label>
            </details>
            <div className="wand-missions-create-actions"><WandButton kind="ghost" onClick={() => setCreating(false)}>取消</WandButton><WandButton kind="primary" type="submit" disabled={busy || !prompt.trim() || !cwd.trim() || providers.size === 0}>{busy ? "正在分派…" : `分派给 ${providers.size} 个 Agent`}</WandButton></div>
          </form>
        </div>
      ) : null}
    </WandDialogSurface>
  );
}
