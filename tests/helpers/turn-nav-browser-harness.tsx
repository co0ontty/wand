// Real production entries, synthetic source data only. No installed service or model calls.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "./realtime-refresh-focus-harness.js";
import { ConversationMessages } from "../../src/web-ui/react/ai-teams/team-chat-view.js";
import { WandUiProvider } from "../../src/web-ui/react/theme.js";
import { installReactUiStyles } from "../../src/web-ui/react/styles.js";
import { jumpToChatTurn } from "../../src/web-ui/react/chat/navigation/turn-jump.js";
import type { ConversationTurn } from "../../src/types.js";

installReactUiStyles();
const h = (window as any).focusRefreshHarness;
const im = createRoot(document.getElementById("im-root")!);
let imScope = "im-A";
(window as any).navigationHarness = {
  h, jumpToChatTurn,
  async ordinary(turns: ConversationTurn[], patch: Record<string, unknown> = {}, count = turns.length) {
    document.getElementById("im-scroll")!.hidden = true;
    document.getElementById("chat-output")!.hidden = false;
    await h.fresh(turns, patch);
    h.state.chatRenderedCount = count;
    h.doRenderChat(true);
    await h.frames();
  },
  async publish(turns: ConversationTurn[], patch: Record<string, unknown> = {}) {
    h.publish(turns, patch); h.doRenderChat(false); await h.frames();
  },
  async im(turns: ConversationTurn[], scope = imScope, active = true) {
    imScope = scope;
    document.getElementById("chat-output")!.hidden = true;
    document.getElementById("im-scroll")!.hidden = false;
    flushSync(() => im.render(<WandUiProvider><ConversationMessages turns={turns} navigationScope={scope}
      taskLabels={{}} group={false} active={active} onOpenConversation={() => {}} /></WandUiProvider>));
    await h.frames();
  },
};
