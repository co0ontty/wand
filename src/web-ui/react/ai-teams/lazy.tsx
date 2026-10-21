import { browserAssetRuntime } from "../../asset-runtime.js";
import * as React from "react";
import { Alert, Flex, Spin } from "antd";
import { DECISION_EXPERT_NAME } from "../../../decision-expert-identity.js";
import { AGENT_TOOL_OPTIONS } from "../../provider-identity";
import { failureMessage } from "../errors";
import { WandButton } from "../ui/button";
import { WandDialogSurface } from "../ui/dialog";
import type { TaskTeamRunPanelProps } from "../issues/team-run-panel";
import type { ConversationMessagesProps, TeamChatViewProps } from "./team-chat-view";
import type { TeamChatPageProps } from "./team-chat-page";
import type { AiTeamsPageProps } from "./teams-page";
import type { DecisionChainEditorProps } from "../settings/decision-chain-editor";
import type { EmployeeListPageProps } from "../agents/employee-list-page";


interface AiTeamsChunk {
  EmployeeListPage: React.ComponentType<EmployeeListPageProps>;
  DecisionChainEditor: React.ComponentType<DecisionChainEditorProps>;
  AiTeamsPage: React.ComponentType<AiTeamsPageProps>;
  TaskTeamRunPanel: React.ComponentType<TaskTeamRunPanelProps>;
  TeamChatView: React.ComponentType<TeamChatViewProps>;
  ConversationMessages: React.ComponentType<ConversationMessagesProps>;
  chatAttachmentPrompt(files: readonly { savedPath: string }[], text: string): string;
  TeamChatPage: React.ComponentType<TeamChatPageProps>;
}

type ChunkGlobals = typeof globalThis & {
  __wandAiTeamsHost?: (key: string) => object;
  __wandAiTeamsChunk?: AiTeamsChunk;
};

let loaded: AiTeamsChunk | null = null;
let pending: Promise<AiTeamsChunk> | null = null;

/** 带内容 hash 的地址：服务端 getScriptContent 与 configPath 一样在下发时替换占位符。 */
const AI_TEAMS_CHUNK_SRC = browserAssetRuntime.aiTeamsChunkSrc;

function loadAiTeamsChunk(): Promise<AiTeamsChunk> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  const globals = globalThis as ChunkGlobals;
  if (globals.__wandAiTeamsChunk) { loaded = globals.__wandAiTeamsChunk; return Promise.resolve(loaded); }
  pending = Promise.all([import("../library-bridge"), import("./host-bridge")]).then(([library, host]) => {
    library.installSharedLibraryBridge();
    host.installAiTeamsHostBridge();
    return new Promise<AiTeamsChunk>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = AI_TEAMS_CHUNK_SRC;
      script.async = true;
      script.onload = () => {
        const chunk = globals.__wandAiTeamsChunk;
        if (chunk) resolve(chunk);
        else reject(new Error("AI 团队脚本没有注册组件"));
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("AI 团队脚本下载失败"));
      };
      document.head.appendChild(script);
    });
  }).then((chunk) => {
    loaded = chunk;
    return chunk;
  }, (error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

function useAiTeamsChunk(enabled = true): { chunk: AiTeamsChunk | null; error: string; retry: () => void } {
  const [chunk, setChunk] = React.useState<AiTeamsChunk | null>(loaded);
  const [error, setError] = React.useState("");
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (chunk || !enabled) return undefined;
    let alive = true;
    loadAiTeamsChunk().then(
      (next) => { if (alive) setChunk(next); },
      (reason: unknown) => { if (alive) setError(failureMessage(reason, "AI 团队加载失败")); },
    );
    return () => { alive = false; };
  }, [chunk, attempt, enabled]);
  const retry = React.useCallback(() => {
    setError("");
    setAttempt((value) => value + 1);
  }, []);
  return { chunk, error, retry };
}

/** The settings trigger is eager; candidate editing reuses the existing team chunk. */
export function DecisionChainEditor({ admin }: { admin: boolean }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const { chunk, error, retry } = useAiTeamsChunk(open);
  return <>
    <WandButton kind="secondary" onClick={() => setOpen(true)}>{`配置「${DECISION_EXPERT_NAME}」调用链`}</WandButton>
    {chunk ? <chunk.DecisionChainEditor admin={admin} open={open} onOpenChange={setOpen}
      providerOptions={AGENT_TOOL_OPTIONS.filter(option => option.engine !== "sdk").map(option => ({ value: option.provider, label: option.label }))}/>
      : <WandDialogSurface open={open} onOpenChange={setOpen} title={`${DECISION_EXPERT_NAME} · 调用链`}>
        {error ? <Alert type="error" showIcon title={<><span>调用链编辑器加载失败。</span><WandButton kind="soft" onClick={retry}>重试</WandButton></>}/>
          : <div role="status" aria-busy="true"><Spin/>正在加载调用链编辑器…</div>}
      </WandDialogSurface>}
  </>;
}

/** 团队页：首次打开时拉取 ai-teams.js，期间显示占位，失败可重试。 */
export function AiTeamsPage(props: AiTeamsPageProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk();
  if (chunk) return <chunk.AiTeamsPage {...props}/>;
  return <Flex vertical gap={12} align="center" justify="center" component="section" style={{ height: "100%" }} className="task-board-native-page" aria-label="AI 团队" aria-busy={!error}>
    {error ? <>
      <Alert type="error" showIcon title={error}/>
      <WandButton kind="soft" size="small" onClick={retry}>重试</WandButton>
    </> : <><Spin/><span role="status">正在加载 AI 团队…</span></>}
  </Flex>;
}

export function EmployeeListPage(props: EmployeeListPageProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk();
  if (chunk) return <chunk.EmployeeListPage {...props}/>;
  return <div role="status">{error || "正在读取员工资料…"}{error ? <WandButton onClick={retry}>重试</WandButton> : <Spin size="small"/>}</div>;
}

/** 任务详情里的团队运行：脚本到位前不占位（没有运行时本来也不渲染）。 */
export function TaskTeamRunPanel(props: TaskTeamRunPanelProps): React.ReactElement | null {
  const { chunk } = useAiTeamsChunk();
  return chunk ? <chunk.TaskTeamRunPanel {...props}/> : null;
}

export async function formatConversationAttachments(files: readonly { savedPath: string }[], text: string): Promise<string> {
  return (await loadAiTeamsChunk()).chatAttachmentPrompt(files, text);
}

export function ConversationMessages(props: ConversationMessagesProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk(props.active !== false);
  if (chunk) return <chunk.ConversationMessages {...props}/>;
  // 占位必须与真实消息列一样占满阅读视口：之前是固定 144px，脚本到位后整列
  // 从 144px 长到视口高度，于是标题/发送按钮/侧栏都跟着重新排一次（实测 0.03~0.05）。
  // 未激活时也不能返回空节点：空节点会让槽位先塌成 0 高，激活那一帧再从 0 长满，
  // 那正是实测里 0.032 那次位移的来源。保留同一个占位框，只收起文字与可访问性。
  const inactive = props.active === false;
  return <div className="conversation-messages-loading" role={inactive ? undefined : "status"} aria-hidden={inactive || undefined}
    style={{ flex: "1 1 auto", minHeight: "100%", display: "flex", alignItems: "center" }}>
    {inactive ? null : <>{error || "正在读取消息组件…"}{error ? <WandButton onClick={retry}>重试</WandButton> : null}</>}
  </div>;
}

/** 群聊页：侧栏点群聊条目进入，脚本到位前显示占位，失败可重试。 */
export function TeamChatPage(props: TeamChatPageProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk();
  if (chunk) return <chunk.TeamChatPage {...props}/>;
  return <Flex vertical gap={12} align="center" justify="center" component="section" style={{ height: "100%" }} className="task-board-native-page" aria-label="群聊" aria-busy={!error}>
    {error ? <>
      <Alert type="error" showIcon title={error}/>
      <WandButton kind="soft" size="small" onClick={retry}>重试</WandButton>
    </> : <><Spin/><span role="status">正在加载群聊…</span></>}
  </Flex>;
}
