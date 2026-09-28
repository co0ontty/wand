import * as React from "react";
import type {
  AiTeam, AiTeamLiveStep, AiTeamLiveUpdate, AiTeamMember, AiTeamRun, AiTeamRunDetail, AiTeamRunSummary,
} from "../../../ai-team-types";
import { jsonBody, requestJson } from "../http-adapter";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../ui/motion-tokens";

export type { AiTeam, AiTeamMember, AiTeamRun, AiTeamRunDetail, AiTeamRunSummary };
export type { AiTeamLiveStep, AiTeamLiveUpdate, AiTeamStep } from "../../../ai-team-types";

export type AiTeamInput = Pick<AiTeam, "name" | "description" | "instructions" | "members" | "requirePlanApproval" | "maxSteps">;

/** 直接开工的回包：运行详情 + 服务端顺手建出来的任务卡 id。 */
export type AiTeamDirectRun = AiTeamRunDetail & { taskId: string };

type Listener = (change: { runId: string; taskId: string }) => void;
const listeners = new Set<Listener>();

/** WS 系统通知 `{ kind: "ai-team-run" }` 的转发口：正在看这次运行的面板据此重新拉取。 */
export function notifyAiTeamRunChanged(change: { runId: string; taskId: string }): void {
  for (const listener of listeners) listener(change);
}

export function subscribeAiTeamRunChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

type LiveListener = (update: AiTeamLiveUpdate) => void;
const liveListeners = new Set<LiveListener>();

/** WS 系统通知 `{ kind: "ai-team-step-live" }` 的转发口（§4.9.1）：只分发，不发请求。 */
export function notifyAiTeamStepLive(update: AiTeamLiveUpdate): void {
  for (const listener of liveListeners) listener(update);
}

/**
 * 订阅运行中步骤的 live 推送。ai-teams chunk 经 lazy.tsx 注册表借本模块时只拿得到
 * `aiTeamsRepository` 对象与 `subscribeAiTeamRunChanges`（名单手写、本步骤不在白名单），
 * 所以下面把这对 live API 同时挂到仓储对象上，chunk 侧走 `aiTeamsRepository.*`。
 */
export function subscribeAiTeamStepLive(listener: LiveListener): () => void {
  liveListeners.add(listener);
  return () => { liveListeners.delete(listener); };
}

/** GET /api/ai-team-runs/:id/live（§4.9.1）：一次性拉当前 running 步骤的 live 文本。 */
export function aiTeamLive(runId: string): Promise<AiTeamLiveUpdate> {
  return requestJson<AiTeamLiveUpdate>(runUrl(runId, "/live"));
}

const runUrl = (runId: string, suffix = ""): string => `/api/ai-team-runs/${encodeURIComponent(runId)}${suffix}`;

/**
 * 团队定义的轻缓存（§5.1 修正 S2）：入口 picker 打开时读一次就够。
 * `ai-team-run` 通知只反映运行进度，不失效团队定义——人设与候选是团队页保存时才变的，
 * 所以下面 create/update/remove 各自清一次；运行通知来了不该重新拉一整页团队。
 */
let teamList: AiTeam[] | null = null;
let teamListPending: Promise<AiTeam[]> | null = null;

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  window.setTimeout(resolve, ms);
});

export const aiTeamsRepository = {
  list(): Promise<AiTeam[]> {
    if (teamList) return Promise.resolve(teamList);
    if (!teamListPending) {
      teamListPending = requestJson<AiTeam[]>("/api/ai-teams")
        .then((list) => {
          teamList = list;
          return list;
        })
        .finally(() => {
          // 失败不留在缓存里，下一次调用重新拉。
          teamListPending = null;
        });
    }
    return teamListPending;
  },
  async create(input: AiTeamInput): Promise<AiTeam> {
    const team = await requestJson<AiTeam>("/api/ai-teams", jsonBody(input));
    teamList = null;
    return team;
  },
  async update(id: string, input: AiTeamInput): Promise<AiTeam> {
    const team = await requestJson<AiTeam>(`/api/ai-teams/${encodeURIComponent(id)}`, jsonBody(input, "PUT"));
    teamList = null;
    return team;
  },
  async remove(id: string): Promise<void> {
    await requestJson(`/api/ai-teams/${encodeURIComponent(id)}`, { method: "DELETE" });
    teamList = null;
  },
  runs(filter: { teamId?: string; activeOnly?: boolean; limit?: number } = {}): Promise<AiTeamRunSummary[]> {
    const params = new URLSearchParams();
    if (filter.teamId) params.set("teamId", filter.teamId);
    if (filter.activeOnly) params.set("active", "1");
    if (filter.limit) params.set("limit", String(filter.limit));
    const query = params.toString();
    return requestJson(`/api/ai-team-runs${query ? `?${query}` : ""}`);
  },
  runsForTask(taskId: string): Promise<AiTeamRun[]> {
    return requestJson(`/api/wand-tasks/${encodeURIComponent(taskId)}/team-runs`);
  },
  /**
   * 同一个群聊会话上的运行（库按创建时间倒序，所以第一个最新）。
   * 群聊页按 chat 会话跟随：服务端在同一个 chat 上接着开新一轮时，页面要跟着切过去，
   * 否则状态条与「工作任务」停在旧的一轮，新步骤根本看不见。
   */
  runsForChat(taskId: string, chatSessionId: string): Promise<AiTeamRun[]> {
    return aiTeamsRepository.runsForTask(taskId)
      .then((runs) => runs.filter((run) => run.chatSessionId === chatSessionId));
  },
  start(taskId: string, teamId: string, note: string): Promise<AiTeamRunDetail> {
    return requestJson(`/api/wand-tasks/${encodeURIComponent(taskId)}/team-runs`, jsonBody({ teamId, note }));
  },
  /**
   * 直接开工（§4.2）：服务端自己建 `team_direct` 卡并按项目解析工作目录，
   * 所以这里只传 workspaceId、不传 cwd —— defaultCwd / scratch 兜底已经被服务端拒掉，
   * 前端也不给 global 工作区开这个口子。
   */
  startDirect(teamId: string, input: { note: string; workspaceId: string }): Promise<AiTeamDirectRun> {
    return requestJson<AiTeamDirectRun>(
      `/api/ai-teams/${encodeURIComponent(teamId)}/runs`,
      jsonBody({ note: input.note, workspaceId: input.workspaceId }),
    );
  },
  /**
   * §7 要求 3：结果在原位停留够时间再前进（成功）或恢复按钮（失败）。
   * 时长只从 ui/motion-tokens 取；reduce-motion 下也不归零，读结果不是位移动画。
   */
  settle(tone: "success" | "error"): Promise<void> {
    return delay(tone === "error" ? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS);
  },
  detail(runId: string): Promise<AiTeamRunDetail> {
    return requestJson(runUrl(runId));
  },
  /** live 文本通道（§4.9.1）：chunk 里的 TeamChatView 只经这个对象借到拉取与订阅。 */
  live: aiTeamLive,
  subscribeAiTeamStepLive,
  approve(runId: string): Promise<AiTeamRunDetail> {
    return requestJson(runUrl(runId, "/approve"), jsonBody({}));
  },
  reject(runId: string, feedback: string): Promise<AiTeamRunDetail> {
    return requestJson(runUrl(runId, "/reject"), jsonBody({ feedback }));
  },
  reply(runId: string, text: string): Promise<AiTeamRunDetail> {
    return requestJson(runUrl(runId, "/reply"), jsonBody({ text }));
  },
  continueRun(runId: string, extraSteps: number): Promise<AiTeamRunDetail> {
    return requestJson(runUrl(runId, "/continue"), jsonBody({ extraSteps }));
  },
  completeStep(runId: string, stepId: string, report: string): Promise<AiTeamRunDetail> {
    return requestJson(runUrl(runId, `/steps/${encodeURIComponent(stepId)}/complete`), jsonBody({ report }));
  },
  stop(runId: string): Promise<AiTeamRunDetail> {
    return requestJson(runUrl(runId, "/stop"), jsonBody({}));
  },
};

/**
 * 入口 picker 用的紧凑项：团队名 + 第二行说明（成员数、擅长什么）。
 * 形状与 workspaces/types.ts 的 WorkspaceTeamOption 结构一致，这里不引那个模块避免循环依赖。
 */
export function aiTeamPickerOption(team: AiTeam): { id: string; name: string; detail: string } {
  const head = `${team.members.length} 人`;
  return {
    id: team.id,
    name: team.name,
    detail: team.description.trim() ? `${head} · ${team.description.trim()}` : head,
  };
}

/**
 * 入口 picker / 项目欢迎页用：团队定义走上面的轻缓存读一次，`null` 表示还在拉。
 * 拉失败当成「没有团队」处理——不能因为团队列表挂了就连带 CLI 也开不了会话。
 */
export function useAiTeamList(enabled: boolean): AiTeam[] | null {
  const [teams, setTeams] = React.useState<AiTeam[] | null>(null);
  React.useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    aiTeamsRepository.list().then(
      (list) => { if (alive) setTeams(list); },
      () => { if (alive) setTeams([]); },
    );
    return () => { alive = false; };
  }, [enabled]);
  return teams;
}

/** 侧栏角标：等你批准计划或回复负责人的运行数。启动拉一次，之后跟着运行通知刷新。 */
export function useAiTeamAttentionCount(): number {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    const load = (): void => {
      void aiTeamsRepository.runs({ activeOnly: true })
        .then((runs) => {
          if (alive) setCount(runs.filter((run) => run.status !== "running").length);
        })
        .catch(() => undefined);
    };
    load();
    const unsubscribe = subscribeAiTeamRunChanges(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return count;
}
