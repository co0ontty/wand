import type { GithubIssue, IssueBinding } from "./types";
import { requestJson } from "../http-adapter";

export const issuesRepository = {
  list(owner: string, repo: string, state = "open"): Promise<GithubIssue[]> {
    return requestJson(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}`);
  },
  create(owner: string, repo: string, title: string, body: string): Promise<GithubIssue> {
    return requestJson(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body }) });
  },
  update(owner: string, repo: string, number: number, state: "open" | "closed"): Promise<GithubIssue> {
    return requestJson(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }) });
  },
  bindings(owner: string, repo: string, number: number): Promise<{ bindings: IssueBinding[] }> {
    return requestJson(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/bindings`);
  },
  bind(owner: string, repo: string, number: number, sessionId: string): Promise<void> {
    return requestJson(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/bindings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) }).then(() => undefined);
  },
};
