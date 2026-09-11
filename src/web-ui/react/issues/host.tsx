import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { WandButton, WandDialogSurface, WandIcon } from "../ui";
import { githubIssuesController, githubIssuesStore } from "./controller";
import { issuesRepository } from "./repository";
import type { GithubIssue, IssueBinding } from "./types";

interface LoadedRepo {
  owner: string;
  repo: string;
}

function issueStateClassName(state: GithubIssue["state"]): string {
  return state === "closed" ? "github-issue-card is-closed" : "github-issue-card";
}

export function GithubIssuesHost(): JSX.Element | null {
  const state = useSyncExternalStore(githubIssuesStore.subscribe, githubIssuesStore.getSnapshot, githubIssuesStore.getSnapshot);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [loadedRepo, setLoadedRepo] = useState<LoadedRepo | null>(null);
  const [issues, setIssues] = useState<GithubIssue[]>([]);
  const [bindings, setBindings] = useState<Record<number, IssueBinding[]>>({});
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const loadGenerationRef = useRef(0);
  const createGenerationRef = useRef(0);

  useEffect(() => {
    if (!state.open) return;
    loadGenerationRef.current += 1;
    createGenerationRef.current += 1;
    setError("");
    setIssues([]);
    setBindings({});
    setLoadedRepo(null);
    setLoading(false);
    setCreating(false);
  }, [state.revision, state.open]);

  async function loadFrom(nextOwner: string, nextRepo: string): Promise<void> {
    if (!nextOwner || !nextRepo) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError("");
    try {
      const next = await issuesRepository.list(nextOwner, nextRepo);
      if (generation !== loadGenerationRef.current) return;
      const entries = await Promise.all(next.map(async (issue) => [
        issue.number,
        (await issuesRepository.bindings(nextOwner, nextRepo, issue.number)).bindings,
      ] as const));
      if (generation !== loadGenerationRef.current) return;
      setLoadedRepo({ owner: nextOwner, repo: nextRepo });
      setIssues(next);
      setBindings(Object.fromEntries(entries));
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : "无法加载 GitHub Issue。");
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }

  async function create(): Promise<void> {
    if (!loadedRepo || !title.trim() || creating) return;
    const target = loadedRepo;
    const generation = ++createGenerationRef.current;
    setCreating(true);
    setError("");
    try {
      await issuesRepository.create(target.owner, target.repo, title.trim(), body.trim());
      if (generation !== createGenerationRef.current) return;
      setTitle("");
      setBody("");
      await loadFrom(target.owner, target.repo);
    } catch (cause) {
      if (generation !== createGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : "无法创建 Issue。");
    } finally {
      if (generation === createGenerationRef.current) setCreating(false);
    }
  }

  async function mutateLoaded(
    issue: GithubIssue,
    action: (target: LoadedRepo) => Promise<void>,
  ): Promise<void> {
    if (!loadedRepo) {
      setError("请先加载仓库，再操作议题。");
      return;
    }
    try {
      await action(loadedRepo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新 Issue。");
    }
  }

  async function toggleState(issue: GithubIssue): Promise<void> {
    await mutateLoaded(issue, async (target) => {
      await issuesRepository.update(target.owner, target.repo, issue.number, issue.state === "open" ? "closed" : "open");
      await loadFrom(target.owner, target.repo);
    });
  }

  async function bind(issue: GithubIssue): Promise<void> {
    if (!state.sessionId) {
      setError("请先选择一个 Wand 会话，再绑定议题。");
      return;
    }
    await mutateLoaded(issue, async (target) => {
      await issuesRepository.bind(target.owner, target.repo, issue.number, state.sessionId);
      const result = await issuesRepository.bindings(target.owner, target.repo, issue.number);
      setBindings((current) => ({ ...current, [issue.number]: result.bindings }));
    });
  }

  const hasRepo = Boolean(loadedRepo);

  return <WandDialogSurface open={state.open} title="GitHub 议题" description="管理项目议题，并绑定到任意 Agent 会话。" className="wand-ui-dialog-content github-issues-dialog" onOpenChange={(open) => { if (!open) githubIssuesController.close(); }}>
    <div className="github-issues-body">
      <section className="github-issues-section" aria-label="选择仓库">
        <h3 className="github-issues-section-title">仓库</h3>
        <div className="github-issues-repo-row">
          <input className="wand-ui-dialog-input" placeholder="仓库所有者" value={owner} onChange={(event) => setOwner(event.currentTarget.value)} />
          <span className="github-issues-repo-separator" aria-hidden="true">/</span>
          <input className="wand-ui-dialog-input" placeholder="仓库名" value={repo} onChange={(event) => setRepo(event.currentTarget.value)} />
          <WandButton kind="primary" onClick={() => void loadFrom(owner.trim(), repo.trim())} disabled={loading}>{loading ? "加载中…" : "加载"}</WandButton>
        </div>
        {loadedRepo && <p className="github-issues-loaded">当前列表 <strong>{loadedRepo.owner}/{loadedRepo.repo}</strong></p>}
        {error && <p className="github-issues-error" role="alert">{error}</p>}
      </section>

      <section className="github-issues-section" aria-label="新建议题">
        <h3 className="github-issues-section-title">新建议题</h3>
        <div className="github-issues-create">
          <div className="github-issues-create-row">
            <input className="wand-ui-dialog-input" placeholder="新议题标题" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
            <WandButton onClick={() => void create()} disabled={!hasRepo || !title.trim() || creating || loading}>{creating ? "创建中…" : "创建议题"}</WandButton>
          </div>
          <textarea className="wand-ui-dialog-input" placeholder="描述（可选）" value={body} onChange={(event) => setBody(event.currentTarget.value)} />
        </div>
      </section>

      <section className="github-issues-section" aria-label="议题列表">
        <h3 className="github-issues-section-title">议题列表</h3>
        <div className="github-issues-list">
          {hasRepo && issues.length === 0 && <p className="github-issues-empty">这个仓库还没有开放的议题。</p>}
          {issues.map((issue) => <article className={issueStateClassName(issue.state)} key={`${loadedRepo?.owner ?? ""}/${loadedRepo?.repo ?? ""}#${issue.number}`}>
            <div className="github-issue-main">
              <strong className="github-issue-title"><span className="github-issue-number">#{issue.number}</span>{issue.title}</strong>
              {issue.labels?.length ? <div className="github-issue-labels">
                {issue.labels.map((label, index) => label.name
                  ? <span className="github-issue-label" key={`${issue.number}-label-${index}`}>{label.name}</span>
                  : null)}
              </div> : null}
            </div>
            <div className="github-issue-actions">
              <span>{(bindings[issue.number] ?? []).length ? `已绑定 ${bindings[issue.number].length} 个会话` : "未绑定会话"}</span>
              <WandButton size="small" kind="secondary" onClick={() => void bind(issue)} disabled={!state.sessionId || !hasRepo}>绑定当前会话</WandButton>
              <WandButton size="small" kind="outline" onClick={() => void toggleState(issue)} disabled={!hasRepo}>{issue.state === "open" ? "关闭" : "重开"}</WandButton>
              {issue.html_url && <a href={issue.html_url} target="_blank" rel="noreferrer"><WandIcon name="git" size={13} /> GitHub</a>}
            </div>
          </article>)}
        </div>
      </section>
    </div>
  </WandDialogSurface>;
}
