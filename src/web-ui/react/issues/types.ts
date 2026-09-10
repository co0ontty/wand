export interface GithubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url?: string;
  labels?: Array<{ name?: string; color?: string }>;
  user?: { login?: string };
  updated_at?: string;
}
export interface IssueBinding { sessionId: string; boundAt: string; }
