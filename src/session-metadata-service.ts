import type { EmployeeTextDeps } from "./employee-text.js";
import { resolveSessionProvider, resolveSystemAiContext } from "./session-ai-context.js";
import { getErrorMessage } from "./error-utils.js";
import { readNativeSessionTitle } from "./native-session-title.js";
import { provisionalSessionTopic, SessionNativeTitleTracker, SessionTopicCoordinator, sessionTopicBlocklistForSnapshot, shouldAcceptGeneratedSessionTitle, shouldGenerateSessionTopicFromInput } from "./session-topic.js";
import type { WandStorage } from "./storage.js";
import type { ConversationTurn, SessionSnapshot, WandConfig } from "./types.js";

/**
 * What the owning manager must provide. The PTY and structured managers keep
 * their own storage model and event shapes; this host only exposes the points
 * where those differ.
 */
export interface SessionMetadataHost<S extends SessionSnapshot = SessionSnapshot> {
  isDisposed(): boolean;
  /** Canonical snapshot the manager owns for this id, or undefined. */
  current(id: string): S | undefined;
  messagesOf(snapshot: S): ConversationTurn[] | undefined;
  /** Commit a topic change through the manager's own write path and status event. */
  commitTopic(id: string, title: string, description: string): void;
  commitTopicGenerating(id: string, generating: boolean): void;
  /** Resolved on every call so per-instance replacements (tests, wiring) are honored. */
  topicCoordinator(): SessionTopicCoordinator;
  nativeTitles(): SessionNativeTitleTracker;
}

export interface SessionMetadataServiceOptions {
  /** Prefix for the topic-generation error log, e.g. "[ProcessManager]". */
  logPrefix: string;
  config: WandConfig;
  storage: WandStorage;
  free?: EmployeeTextDeps["free"];
}

/**
 * Topic (title/description) generation and native-title precedence shared by
 * both session managers. Execution, permissions and persistence stay in each
 * manager; this service only decides what the title should be.
 */
export class SessionMetadataService<S extends SessionSnapshot = SessionSnapshot> {
  constructor(
    private readonly host: SessionMetadataHost<S>,
    private readonly options: SessionMetadataServiceOptions,
  ) {}

  /**
   * Seeds a provisional title from the prompt and queues model/native title
   * generation. Callers handle their own skip rules and iteration-prompt logging
   * before calling this, so the order of those checks stays per manager.
   */
  generateTopicForPrompt(id: string, prompt: string): void {
    const snapshot = this.host.current(id);
    if (this.host.isDisposed() || !snapshot) return;
    const { config, storage, free } = this.options;
    const nativeTitles = this.host.nativeTitles();
    const topicCoordinator = this.host.topicCoordinator();
    const blockedTitles = sessionTopicBlocklistForSnapshot(snapshot, storage);
    // CLI 自己起了名字就归它，模型标题与输入首行都不再覆盖；取不到原生标题才走系统硅基员工。
    const hasNativeTitle = nativeTitles.has(id);
    const provisional = provisionalSessionTopic(prompt, blockedTitles);
    if (
      provisional
      && !hasNativeTitle
      && shouldGenerateSessionTopicFromInput(prompt)
      && (snapshot.title !== provisional.title || snapshot.description !== provisional.description)
    ) {
      this.host.commitTopic(id, provisional.title, provisional.description);
    }
    topicCoordinator.request(id, {
      messages: this.host.messagesOf(snapshot),
      input: prompt,
      cwd: snapshot.cwd,
      language: config.language,
      ai: resolveSystemAiContext(snapshot, config, storage.getSystemSiliconEmployee(), free),
      readNativeTitle: () => readNativeSessionTitle(
        resolveSessionProvider(snapshot),
        snapshot.claudeSessionId,
        snapshot.cwd,
      ),
      hasNativeTitle,
      onGenerating: (generating) => {
        if (!this.host.isDisposed()) this.host.commitTopicGenerating(id, generating);
      },
      onTopic: ({ title, description, source }) => {
        if (this.host.isDisposed() || !this.host.current(id)) return;
        if (source === "native") {
          this.applyNativeTitle(id, title, blockedTitles);
          return;
        }
        if (this.host.nativeTitles().has(id)) return;
        if (shouldAcceptGeneratedSessionTitle(title, blockedTitles)) {
          this.host.commitTopic(id, title, description);
        }
      },
      onError: (error) => {
        console.error(`${this.options.logPrefix} Failed to generate session topic ${id}:`, getErrorMessage(error));
      },
    });
  }

  /** 原生标题优先于模型标题：只受「不能是任务名/目录名」约束，命中且变化时才落库。 */
  private applyNativeTitle(id: string, title: string, blockedTitles: readonly string[]): void {
    this.host.nativeTitles().record(id, title);
    const current = this.host.current(id);
    if (!current || !shouldAcceptGeneratedSessionTitle(title, blockedTitles)) return;
    if (current.title === title && current.description === title) return;
    this.host.commitTopic(id, title, title);
  }
}
