// Development-only component harness: real TeamChatView, real WandDialogSurface/Portal, synthetic turns.
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { AiTeamRunDetail } from "../../src/ai-team-types";
import type { ConversationTurn } from "../../src/types";
import { installAiTeamComposerAdapter } from "../../src/web-ui/browser/ai-team-composer-adapter";
import { TeamChatView } from "../../src/web-ui/react/ai-teams/team-chat-view";
import { notifyAiTeamStepLive } from "../../src/web-ui/react/ai-teams/repository";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles";

installReactUiStyles();
installStyleSheet("harness-team-chat-styles", aiTeamsChunkStyles);
installAiTeamComposerAdapter();
const longName = "超级长的设计师张 三".repeat(8);
const stamp = (n: number): string => `2026-09-29T10:00:${String(n).padStart(2, "0")}.000Z`;
const makeTurn = (text: string, n: number, role: "user" | "assistant" = "assistant"): ConversationTurn => ({
  role, createdAt: stamp(n), content: [{ type: "text", text }],
  ...(role === "assistant" ? { author: { id: "m_dev", name: "开发", sessionId: "member-1" } } : {}),
});
const doc = (name: string): string => `依据 @${name} 阅读报告\n${"报告正文。".repeat(155)}`;
const base: AiTeamRunDetail = {
  run: {
    id: "run-1", status: "done", chatSessionId: "chat-1", objective: "群聊验证",
    team: { id: "team", name: "测试团队", members: [
      { id: "m_dev", name: "开发", isLeader: false },
      { id: "m_design", name: "设计师", isLeader: false },
      { id: "m_long", name: longName, isLeader: false },
    ] }, stepsUsed: 1, stepLimit: 8,
  },
  chatTurns: [
    { ...makeTurn("邀请 @设计师 加入群聊", 0), notice: true },
    makeTurn("邀请 @设计师 加入群聊", 1),
    makeTurn(doc(longName), 2),
    makeTurn(doc("设计师"), 3, "user"),
  ],
  steps: [], memberStates: {},
} as unknown as AiTeamRunDetail;

const liveStep = {
  stepId: "step-1", seq: 1, memberId: "m_dev", memberName: "开发", provider: "codex",
  sessionId: "member-1", state: "working", text: "正在检查工作区", omittedChars: 0,
  updatedAt: stamp(5),
} as const;

function Harness(): React.ReactElement {
  const [detail, setDetail] = React.useState(base);
  const [staleRun, setStaleRun] = React.useState(false);
  const nativeFetch = React.useRef(window.fetch.bind(window));
  const heldDetail = React.useRef(false);
  const releaseDetail = React.useRef<(() => void) | null>(null);
  const releasePosts = React.useRef<Array<() => void>>([]);
  (window as typeof window & { teamHarness?: object }).teamHarness = {
    append: (text: string, n: number): void => setDetail((current) => ({
      ...current, chatTurns: [...current.chatTurns, makeTurn(text, n)],
    })),
    repeat: (): void => setDetail((current) => ({
      ...current, chatTurns: current.chatTurns.map((turn) => ({ ...turn })),
    })),
    remove: (at: number): void => setDetail((current) => ({
      ...current, chatTurns: current.chatTurns.filter((_, i) => i !== at),
    })),
    roster: (): void => setDetail((current) => ({
      ...current, run: { ...current.run, team: { ...current.run.team, members: [] } },
    })),
    switchRun: (): void => setDetail((current) => ({
      ...current, run: { ...current.run, id: "run-2", chatSessionId: "chat-2" },
    })),
    switchBack: (): void => setDetail(base),
    currentRun: (): string => detail.run.id,
    setStaleRun: (stale: boolean): void => setStaleRun(stale),
    switchRunSameChat: (): void => setDetail((current) => ({
      ...current, run: { ...current.run, id: "run-2", objective: "接续第二轮" },
    })),
    holdOldDetail: (): void => {
      window.fetch = (input, init) => {
        if (String(input) === "/api/ai-team-runs/run-1") {
          heldDetail.current = true;
          return new Promise<Response>((resolve) => {
            releaseDetail.current = () => resolve(new Response(JSON.stringify(base), {
              status: 200, headers: { "Content-Type": "application/json" },
            }));
          });
        }
        return nativeFetch.current(input, init);
      };
    },
    oldDetailHeld: (): boolean => heldDetail.current,
    releaseOldDetail: (): void => releaseDetail.current?.(),
    holdPosts: (): void => {
      window.fetch = (input, init) => String(input) === "/api/structured-sessions/chat-1/messages"
        ? new Promise<Response>((resolve) => {
          releasePosts.current.push(() => resolve(new Response(JSON.stringify({ error: "unknown" }), {
            status: 503, headers: { "Content-Type": "application/json" },
          })));
        })
        : nativeFetch.current(input, init);
    },
    heldPostCount: (): number => releasePosts.current.length,
    releasePost: (index: number): void => releasePosts.current[index]?.(),
    startLive: (): void => setDetail((current) => ({
      ...current, run: { ...current.run, status: "running" },
    })),
    addPlan: (): void => setDetail((current) => ({
      ...current, chatTurns: [...current.chatTurns, {
        ...makeTurn(`${"计划正文。".repeat(110)}\n1. **@设计师** 编写规格（依据：第 1 步的产物）`, 7),
        author: { id: "m_leader", name: "负责人", leader: true },
      }],
    })),
    pushLive: (present = true): void => notifyAiTeamStepLive({
      runId: detail.run.id, taskId: "task-1", steps: present ? [liveStep] : [],
    }),
  };
  return <TeamChatView detail={detail} onChange={setDetail} staleRun={staleRun}/>;
}

const root = createRoot(document.getElementById("root")!);
(window as typeof window & { unmountTeamHarness?: () => void }).unmountTeamHarness = () => root.unmount();
root.render(<React.StrictMode><Harness/></React.StrictMode>);
