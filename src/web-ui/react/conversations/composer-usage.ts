import { composerAvatarActivity, type AvatarFileActivity } from "../../composer-avatar-activity.js";
import * as React from "react";
import type { ConversationTurn } from "../../../types.js";
import { latestChatUsage } from "../../chat-message-meta.js";
import { conversationActivityRepository as repository } from "./activity-repository.js";
import { computeRunningSignal } from "../../session-activity.js";
import type { RunningActivityShape } from "../../running-activity.js";
import { activityRunning } from "./activity-model.js";

/** Read-only projection of the selected execution; late replies never cross conversations. */
export function useComposerUsage(sessionId: string | undefined, active: boolean, revision?: string): { usage: ConversationTurn["usage"]; activity?: RunningActivityShape; fileActivity?: AvatarFileActivity } {
  const [snapshot, setSnapshot] = React.useState<{ id: string; usage: ConversationTurn["usage"]; activity: RunningActivityShape; fileActivity: AvatarFileActivity }>();
  React.useEffect(() => {
    if (!sessionId || !active) return;
    let retired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let epoch = 0;
    const refresh = async (): Promise<void> => {
      if (retired || document.hidden) return;
      controller?.abort(); const request = new AbortController(); controller = request;
      const current = ++epoch;
      try {
        const session = await repository.session(sessionId, request.signal);
        if (retired || current !== epoch || session.id !== sessionId) return;
        setSnapshot({ id: sessionId, usage: latestChatUsage(session.messages ?? []), fileActivity: composerAvatarActivity({ ...session, ptyRunning: computeRunningSignal(session).ptyRunning }, session.messages), activity: {
          status: session.status, archived: session.archived, structuredState: session.structuredState,
          permissionBlocked: session.permissionBlocked, pendingEscalation: session.pendingEscalation,
          queuedMessages: session.queuedMessages, ptyRunning: computeRunningSignal(session).ptyRunning,
          turnStartedAt: session.ptyTurnStartedAt, lastActivityAt: session.ptyLastActivityAt,
        } });
        // An existing execution can resume after being idle; keep a bounded read
        // while visible, and refresh immediately when its conversation changes.
        timer = setTimeout(() => void refresh(), activityRunning(session) ? 3000 : 10000);
      } catch {
        if (!retired && current === epoch && !request.signal.aborted) timer = setTimeout(() => void refresh(), 10000);
      }
    };
    const visibility = (): void => { clearTimeout(timer); if (!document.hidden) void refresh(); };
    void refresh(); document.addEventListener("visibilitychange", visibility);
    return () => { retired = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [sessionId, active, revision]);
  return snapshot && snapshot.id === sessionId ? snapshot : { usage: undefined };
}
