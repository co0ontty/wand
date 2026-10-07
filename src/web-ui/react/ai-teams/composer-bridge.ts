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
  readonly recovery?: { text: string; attachments: readonly TeamChatAttachment[] } | null;
}

type TeamChatEdit =
  | { text: string; expectedRevision?: number; persist?: boolean }
  | { addAttachment: TeamChatAttachment }
  | { removeAttachment: number }
  | { recoverCapture: true }
  | { acknowledgeRevision: number }
  | { forgetRecovery: true };

interface TeamChatComposerRuntime {
  read(sessionId: string | null | undefined): TeamChatDraft;
  edit(sessionId: string | null | undefined, change: TeamChatEdit): boolean;
  submit<T>(sessionId: string, text: string,
    deliver: (payload: { text: string; attachments: readonly TeamChatAttachment[] }) => Promise<T>): Promise<T>;
  subscribe(listener: () => void): () => void;
  discardScope?(prefix: string): void;
  transfer?(from: string, to: string, expectedRevision: number): boolean;
}

let runtime: TeamChatComposerRuntime | null = null;
const readinessListeners = new Set<() => void>();

export function configureTeamChatComposerRuntime(next: TeamChatComposerRuntime): () => void {
  runtime = next;
  readinessListeners.forEach(listener => listener());
  return () => { if (runtime === next) { runtime = null; readinessListeners.forEach(listener => listener()); } };
}

function current(): TeamChatComposerRuntime {
  if (!runtime) throw new Error("群聊输入服务尚未就绪。");
  return runtime;
}

/** The team chat projects the same per-session composer as the main chat. */
export const teamChatComposer = {
  discardScope: (prefix: string) => current().discardScope?.(prefix),
  ready: () => runtime !== null,
  subscribeReady: (listener: () => void) => { readinessListeners.add(listener); return () => { readinessListeners.delete(listener); }; },
  read: (sessionId: string | null | undefined) => current().read(sessionId),
  edit: (sessionId: string | null | undefined, change: TeamChatEdit) => current().edit(sessionId, change),
  submit: <T>(sessionId: string, text: string,
    deliver: (payload: { text: string; attachments: readonly TeamChatAttachment[] }) => Promise<T>) =>
    current().submit(sessionId, text, deliver),
  subscribe: (listener: () => void) => current().subscribe(listener),
  revision: (sessionId: string | null | undefined) => current().read(sessionId).revision,
  transfer: (from: string, to: string, expectedRevision: number) => current().transfer?.(from, to, expectedRevision) ?? false,
};
