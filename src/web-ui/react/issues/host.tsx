import { useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { WandButton, WandDialogSurface, WandIcon } from "../ui";
import { githubIssuesController, githubIssuesStore } from "./controller";
import { issuesRepository } from "./repository";
import type { GithubIssue, IssueBinding } from "./types";

export function GithubIssuesHost(): JSX.Element | null {
  const state = useSyncExternalStore(githubIssuesStore.subscribe, githubIssuesStore.getSnapshot, githubIssuesStore.getSnapshot);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [issues, setIssues] = useState<GithubIssue[]>([]);
  const [bindings, setBindings] = useState<Record<number, IssueBinding[]>>({});
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (state.open) { setError(""); setIssues([]); setBindings({}); } }, [state.revision, state.open]);
  async function load(): Promise<void> { if (!owner.trim() || !repo.trim()) return; setLoading(true); setError(""); try { const next = await issuesRepository.list(owner.trim(), repo.trim()); setIssues(next); const entries = await Promise.all(next.map(async (issue) => [issue.number, (await issuesRepository.bindings(owner.trim(), repo.trim(), issue.number)).bindings] as const)); setBindings(Object.fromEntries(entries)); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法加载 GitHub Issue。"); } finally { setLoading(false); } }
  async function create(): Promise<void> { if (!title.trim()) return; try { await issuesRepository.create(owner.trim(), repo.trim(), title.trim(), body.trim()); setTitle(""); setBody(""); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建 Issue。"); } }
  async function toggleState(issue: GithubIssue): Promise<void> { try { await issuesRepository.update(owner.trim(), repo.trim(), issue.number, issue.state === "open" ? "closed" : "open"); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法更新 Issue。"); } }
  async function bind(issue: GithubIssue): Promise<void> { if (!state.sessionId) { setError("请先选择一个 Wand 会话，再绑定议题。"); return; } try { await issuesRepository.bind(owner.trim(), repo.trim(), issue.number, state.sessionId); const result = await issuesRepository.bindings(owner.trim(), repo.trim(), issue.number); setBindings((current) => ({ ...current, [issue.number]: result.bindings })); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法绑定会话。"); } }
  return <WandDialogSurface open={state.open} title="GitHub 议题" description="在 Wand 中管理项目议题，并将议题绑定到任意 Agent 会话。" className="wand-ui-dialog-content github-issues-dialog" onOpenChange={(open) => { if (!open) githubIssuesController.close(); }}>
    <div className="github-issues-toolbar"><input className="wand-ui-dialog-input" placeholder="仓库所有者" value={owner} onChange={(event) => setOwner(event.currentTarget.value)} /><span>/</span><input className="wand-ui-dialog-input" placeholder="仓库名" value={repo} onChange={(event) => setRepo(event.currentTarget.value)} /><WandButton kind="primary" onClick={() => void load()} disabled={loading}>加载</WandButton></div>
    {error && <p className="github-issues-error">{error}</p>}
    <div className="github-issues-create"><input className="wand-ui-dialog-input" placeholder="新议题标题" value={title} onChange={(event) => setTitle(event.currentTarget.value)} /><textarea className="wand-ui-dialog-input" placeholder="描述（可选）" value={body} onChange={(event) => setBody(event.currentTarget.value)} /><WandButton onClick={() => void create()} disabled={!owner.trim() || !repo.trim() || !title.trim()}>创建议题</WandButton></div>
    <div className="github-issues-list">{issues.map((issue) => <article className="github-issue-card" key={issue.number}><div><strong>#{issue.number} {issue.title}</strong><span>{issue.labels?.map((label) => label.name).filter(Boolean).join(" · ")}</span></div><div className="github-issue-actions"><span>{(bindings[issue.number] ?? []).length ? `${bindings[issue.number].length} 个会话` : "未绑定"}</span><WandButton kind="secondary" onClick={() => void bind(issue)} disabled={!state.sessionId}>绑定当前会话</WandButton><WandButton onClick={() => void toggleState(issue)}>{issue.state === "open" ? "关闭" : "重开"}</WandButton>{issue.html_url && <a href={issue.html_url} target="_blank" rel="noreferrer"><WandIcon name="git" size={14} /> GitHub</a>}</div></article>)}</div>
  </WandDialogSurface>;
}
