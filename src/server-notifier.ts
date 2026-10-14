/**
 * 服务端系统通知的单一出口。
 *
 * 路由与后台服务要在 WebSocket 建立之前就持有通知函数，所以不能直接捕获 wsManager。
 * 这里先创建 Notifier（所有回调是稳定引用），WebSocket 就绪后再 `attach` 一次；
 * attach 之前的通知静默丢弃（与原来的晚绑定 `let` 闭包语义一致）。
 */
import type { AiTeamLiveUpdate } from "./ai-team-types.js";
import type { ConversationSessionUpdate } from "./conversation-types.js";
import type { ProcessEvent } from "./process-manager.js";

export type AiTeamChangeNotice =
  | { kind: "ai-team-run"; runId: string; taskId: string }
  | { kind: "ai-team-definition"; teamId: string }
  | { kind: "silicon-employee-definition"; employeeId: string };

export type ServerEventSink = (event: ProcessEvent) => void;

export class ServerNotifier {
  private sink: ServerEventSink | null = null;

  /** 接上 WebSocket 广播；之前的通知被丢弃。 */
  attach(sink: ServerEventSink): void {
    this.sink = sink;
  }

  /** 发送任意 `__system__` 通知。 */
  system(data: Record<string, unknown>): void {
    this.sink?.({ type: "notification", sessionId: "__system__", data } as ProcessEvent);
  }

  /** 团队 / 员工 / 运行的变更通知。 */
  aiTeamChanged = (data: AiTeamChangeNotice): void => {
    this.system(data);
  };

  /** 运行中步骤的 live 文本（§4.9）。 */
  aiTeamLive = (update: AiTeamLiveUpdate): void => {
    this.system({ kind: "ai-team-step-live", ...update });
  };

  conversationSession = (update: ConversationSessionUpdate): void => {
    this.system({ kind: "conversation-session-preview", ...update });
  };
}
