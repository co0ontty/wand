import { isAmbiguousComposerSubmissionFailure, shouldPersistComposerDraft } from "./composer-draft.js";

export interface ComposerAttachment {
  readonly file: File;
  readonly name: string;
  readonly size: number;
  readonly previewUrl?: string | null;
}

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly memoryOnly: boolean;
  readonly revision: number;
  readonly recovery?: ComposerPayload | null;
}

export interface ComposerPayload {
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
}

interface ComposerSession {
  text: string;
  attachments: ComposerAttachment[];
  memoryOnly: boolean;
  revision: number;
  submissions: Map<string, Promise<unknown>>;
  recovery?: { payload: ComposerPayload; persist: boolean };
}

interface ComposerDependencies {
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> & Partial<Pick<Storage, "key" | "length">>;
  isUnloading: () => boolean;
  disposeAttachment: (attachment: ComposerAttachment) => void;
}

export type ComposerEdit =
  | { text: string; persist?: boolean; expectedRevision?: number }
  | { addAttachment: ComposerAttachment }
  | { removeAttachment: number }
  | { clear: true }
  | { restore: ComposerPayload; persist?: boolean }
  | { preserve: string }
  | { recoverCapture: true }
  | { acknowledgeRevision: number }
  | { forgetRecovery: true };

export function composerPayloadFingerprint(payload: ComposerPayload): string {
  const files = payload.attachments.map((item) =>
    [item.name, item.size, item.file.lastModified || 0].join(":"),
  ).join("|");
  return payload.text.trim() + "\u0000" + files;
}

/** Owns drafts and captured submissions; DOM/React only render its snapshots. */
export class ComposerStore {
  private readonly sessions = new Map<string, ComposerSession>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(private readonly dependencies: ComposerDependencies) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private session(sessionId: string): ComposerSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      let text = "";
      try { text = this.dependencies.storage().getItem("wand-draft-" + sessionId) ?? ""; } catch {}
      session = { text, attachments: [], memoryOnly: false, revision: ++this.revision, submissions: new Map() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  read(sessionId: string | null | undefined): ComposerDraft {
    const session = sessionId ? this.session(sessionId) : null;
    return {
      text: session?.text ?? "",
      attachments: session?.attachments.slice() ?? [],
      memoryOnly: session?.memoryOnly ?? false,
      revision: session?.revision ?? 0,
      recovery: session?.recovery?.payload ?? null,
    };
  }

  private writeText(sessionId: string, session: ComposerSession, text: string, persist?: boolean): void {
    if (session.text !== text) session.revision = ++this.revision;
    session.text = text;
    if (persist === false) {
      session.memoryOnly = true;
      try { this.dependencies.storage().removeItem("wand-draft-" + sessionId); } catch {}
    } else if (shouldPersistComposerDraft(persist, this.dependencies.isUnloading())) {
      session.memoryOnly = false;
      try { this.dependencies.storage().setItem("wand-draft-" + sessionId, text); } catch {}
    }
  }

  /** Returns false when a late text transformation no longer owns this draft. */
  edit(sessionId: string | null | undefined, change: ComposerEdit): boolean {
    if (!sessionId) return false;
    if ("text" in change && change.expectedRevision !== undefined && !this.sessions.has(sessionId)) return false;
    const session = this.session(sessionId);
    if ("text" in change) {
      if (change.expectedRevision !== undefined && change.expectedRevision !== session.revision) return false;
      this.writeText(sessionId, session, change.text, change.persist);
    } else if ("preserve" in change) {
      this.writeText(sessionId, session, change.preserve, !session.memoryOnly);
    } else if ("addAttachment" in change) {
      session.attachments.push(change.addAttachment);
      session.revision = ++this.revision;
    } else if ("removeAttachment" in change) {
      if (change.removeAttachment < 0 || change.removeAttachment >= session.attachments.length) return false;
      const [removed] = session.attachments.splice(change.removeAttachment, 1);
      this.dependencies.disposeAttachment(removed);
      session.revision = ++this.revision;
    } else if ("acknowledgeRevision" in change) {
      if (session.revision !== change.acknowledgeRevision) return false;
      session.attachments.forEach(this.dependencies.disposeAttachment);
      session.attachments = [];
      return this.edit(sessionId, { clear: true });
    } else if ("forgetRecovery" in change) {
      session.recovery?.payload.attachments.forEach(this.dependencies.disposeAttachment);
      session.recovery = undefined;
      session.revision = ++this.revision;
    } else if ("recoverCapture" in change) {
      const capture = session.recovery;
      if (!capture) return false;
      session.recovery = undefined;
      return this.edit(sessionId, { restore: capture.payload, persist: capture.persist });
    } else if ("restore" in change) {
      const text = change.restore.text;
      const current = session.text;
      this.writeText(sessionId, session,
        current && current !== text ? (text ? text + "\n" + current : current) : text,
        change.persist,
      );
      if (change.restore.attachments.length > 0) {
        session.attachments = [...change.restore.attachments,
          ...session.attachments.filter((item) => !change.restore.attachments.includes(item))];
        session.revision = ++this.revision;
      }
    } else {
      session.revision = ++this.revision;
      session.text = "";
      session.memoryOnly = false;
      try { this.dependencies.storage().removeItem("wand-draft-" + sessionId); } catch {}
    }
    this.notify();
    return true;
  }

  /** Explicit adoption of an unaddressed draft; never overwrite a recipient's own draft. */
  transfer(from: string, to: string, expectedRevision: number): boolean {
    const source = this.sessions.get(from);
    if (!source || source.revision !== expectedRevision || source.submissions.size) return false;
    const target = this.session(to);
    if (target.text || target.attachments.length || target.submissions.size) return false;
    target.attachments = source.attachments;
    target.revision = ++this.revision;
    source.attachments = [];
    this.writeText(to, target, source.text, !source.memoryOnly);
    this.edit(from, { clear: true });
    this.notify();
    return true;
  }

  pendingSubmission(sessionId: string | null | undefined, payload: ComposerPayload): Promise<unknown> | null {
    return sessionId ? this.session(sessionId).submissions.get(composerPayloadFingerprint(payload)) ?? null : null;
  }

  /** Capture and clear before awaiting; failure restores only this captured payload. */
  submit<T>(sessionId: string, text: string, deliver: (payload: ComposerPayload) => Promise<T>): Promise<T> {
    const session = this.session(sessionId);
    const payload = { text, attachments: session.attachments.slice() };
    const fingerprint = composerPayloadFingerprint(payload);
    const existing = session.submissions.get(fingerprint);
    if (existing) return existing as Promise<T>;
    session.attachments = [];
    this.edit(sessionId, { clear: true });
    const submission = Promise.resolve().then(() => deliver(payload)).then((result) => {
      payload.attachments.forEach(this.dependencies.disposeAttachment);
      return result;
    }, (error: unknown) => {
      if (this.sessions.get(sessionId) === session) {
        const persist = !isAmbiguousComposerSubmissionFailure(error);
        if (sessionId.startsWith("conversation-draft:") && (session.text || session.attachments.length)) {
          // A new instance composer never inserts the old capture into text being edited.
          session.recovery?.payload.attachments.forEach(this.dependencies.disposeAttachment);
          session.recovery = { payload, persist };
          session.revision = ++this.revision;
          this.notify();
        } else this.edit(sessionId, { restore: payload, persist });
      } else {
        // A server list removed this session while delivery was pending.
        // Its late failure must release the capture instead of recreating a draft.
        payload.attachments.forEach(this.dependencies.disposeAttachment);
      }
      throw error;
    }).finally(() => {
      if (session.submissions.get(fingerprint) === submission) session.submissions.delete(fingerprint);
    });
    session.submissions.set(fingerprint, submission);
    return submission;
  }

  /** Explicit conversation deletion invalidates in-flight captures and removes every target draft. */
  discardScope(prefix: string): void {
    for (const [id, session] of this.sessions) {
      if (!id.startsWith(prefix)) continue;
      new Set([...session.attachments, ...(session.recovery?.payload.attachments ?? [])]).forEach(this.dependencies.disposeAttachment);
      this.sessions.delete(id);
      try { this.dependencies.storage().removeItem("wand-draft-" + id); } catch {}
    }
    try {
      const storage = this.dependencies.storage();
      for (let index = (storage.length ?? 0) - 1; index >= 0; index--) {
        const key = storage.key?.(index);
        if (key?.startsWith("wand-draft-" + prefix)) storage.removeItem(key);
      }
    } catch {}
    this.notify();
  }

  retain(sessionIds: ReadonlySet<string>): void {
    for (const [id, session] of this.sessions) {
      // Logical instance/target drafts exist before a transport session and survive list refreshes.
      if (sessionIds.has(id) || id.startsWith("conversation-draft:")) continue;
      session.attachments.forEach(this.dependencies.disposeAttachment);
      this.sessions.delete(id);
      try { this.dependencies.storage().removeItem("wand-draft-" + id); } catch {}
    }
  }
}

interface QueueVersion { revision: number; epoch: number }

/** Per-session freshness prevents HTTP responses or rollback from undoing newer WS state. */
export class ComposerQueueClock {
  private readonly versions = new Map<string, QueueVersion>();

  read(sessionId: string): QueueVersion {
    return { ...(this.versions.get(sessionId) ?? { revision: 0, epoch: 0 }) };
  }

  advance(sessionId: string, source: "local" | "server"): QueueVersion {
    const version = this.read(sessionId);
    if (source === "server") version.epoch += 1;
    else version.revision += 1;
    this.versions.set(sessionId, version);
    return { ...version };
  }

  filter<T extends { queuedMessages?: unknown }>(snapshot: T, sessionId: string, request: QueueVersion): T {
    const current = this.read(sessionId);
    if (current.revision === request.revision && current.epoch === request.epoch) return snapshot;
    const { queuedMessages: _queue, ...rest } = snapshot;
    return rest as T;
  }

  rollback(sessionId: string, current: readonly string[], previous: readonly string[],
    request: QueueVersion, appended?: { text: string; index: number }): string[] | null {
    const version = this.read(sessionId);
    if (version.epoch !== request.epoch) return null;
    if (!appended && version.revision !== request.revision) return null;
    let next = previous.slice();
    if (appended) {
      next = current.slice();
      const index = next[appended.index] === appended.text
        ? appended.index : next.lastIndexOf(appended.text);
      if (index < 0) return null;
      next.splice(index, 1);
    }
    this.advance(sessionId, "local");
    return next;
  }
}
