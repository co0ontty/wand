import type { GithubIssue, IssueBinding } from "./types";
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok || value.error) throw new Error(value.error || `请求失败（${response.status}）`);
  return value as T;
}
export const issuesRepository = {
  list(owner: string, repo: string, state = "open"): Promise<GithubIssue[]> {
    return json(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}`);
  },
  create(owner: string, repo: string, title: string, body: string): Promise<GithubIssue> {
    return json(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body }) });
  },
  update(owner: string, repo: string, number: number, state: "open" | "closed"): Promise<GithubIssue> {
    return json(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }) });
  },
  bindings(owner: string, repo: string, number: number): Promise<{ bindings: IssueBinding[] }> {
    return json(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/bindings`);
  },
  bind(owner: string, repo: string, number: number, sessionId: string): Promise<void> {
    return json(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/bindings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) }).then(() => undefined);
  },
};
