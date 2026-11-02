import type { MentionTarget } from "./mention-strip";

export interface DocumentComment {
  id: string;
  author: string;
  timestamp: string;
  text: string;
  applied: boolean; // true = 已在当前版本中采用; false = 待下次生成采用
  appliedInRev?: string;
  mention?: MentionTarget;
}

export interface DocumentRevision {
  id: string;
  timestamp: string;
  author: string;
  summary: string;
  source: "auto" | "manual" | "ai" | "builtin";
  title: string;
  content: string;
}

export interface DocumentWithHistory {
  id: string;
  library: string;
  title: string;
  content: string;
  role?: boolean;
  origin?: "manual" | "conversation" | "builtin" | "ai-draft" | "automatic" | "unknown";
  history: DocumentRevision[];
  comments: DocumentComment[];
}
