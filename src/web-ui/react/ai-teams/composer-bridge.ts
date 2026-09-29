export interface TeamChatAttachment {
  readonly file: File;
  readonly name: string;
  readonly size: number;
  readonly previewUrl?: string | null;
}

export interface TeamChatDraft {
  readonly text: string;
  readonly attachments: readonly TeamChatAttachment[];
  readonly revision: number;
}

type TeamChatEdit =
  | { text: string }
  | { addAttachment: TeamChatAttachment }
  | { removeAttachment: number };

interface TeamChatComposerRuntime {
  read(sessionId: string | null | undefined): TeamChatDraft;
  edit(sessionId: string | null | undefined, change: TeamChatEdit): boolean;
  submit<T>(sessionId: string, text: string,
    deliver: (payload: { text: string; attachments: readonly TeamChatAttachment[] }) => Promise<T>): Promise<T>;
  subscribe(listener: () => void): () => void;
}

let runtime: TeamChatComposerRuntime | null = null;

export function configureTeamChatComposerRuntime(next: TeamChatComposerRuntime): () => void {
  runtime = next;
  return () => { if (runtime === next) runtime = null; };
}

function current(): TeamChatComposerRuntime {
  if (!runtime) throw new Error("群聊输入服务尚未就绪。");
  return runtime;
}

/** The team chat projects the same per-session composer as the main chat. */
export const teamChatComposer = {
  read: (sessionId: string | null | undefined) => current().read(sessionId),
  edit: (sessionId: string | null | undefined, change: TeamChatEdit) => current().edit(sessionId, change),
  submit: <T>(sessionId: string, text: string,
    deliver: (payload: { text: string; attachments: readonly TeamChatAttachment[] }) => Promise<T>) =>
    current().submit(sessionId, text, deliver),
  subscribe: (listener: () => void) => current().subscribe(listener),
  revision: (sessionId: string | null | undefined) => current().read(sessionId).revision,
};
