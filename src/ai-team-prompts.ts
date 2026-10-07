import { teamMemberEmployee } from "./ai-team-employee-binding.js";
import { memberAgents, type AiTeam, type AiTeamMember, type AiTeamRun, type AiTeamRunStatus, type AiTeamStep, type TeamMemberRole } from "./ai-team-types.js";
import type { WandTaskAgent } from "./task-types.js";
import type { ConversationTurn } from "./types.js";

export const AI_TEAM_REPORT_DIR = ".wand-team";
export const AI_TEAM_MAX_ASSIGN_STEPS = 5;
const MESSAGE_MAX = 2000;
const TITLE_MAX = 80;
const INSTRUCTIONS_MAX = 8000;

/**
 * 消息里引用文件用的固定标签：用户消息只给路径，怎么用写在系统提示的「交接文件」段
 * （`leaderSystemPrompt` / `memberSystemPrompt`），每轮不重复同一句规则。
 */
const ROUND_REPORT_LABEL = "本轮报告文件";
const HANDOFF_LABEL = "上游交接文件";
const CHAT_HISTORY_LABEL = "本群聊之前的记录";

export interface AiTeamAssignedStep {
  memberId: string;
  title: string;
  instructions: string;
  /** 依赖本次 steps 里的哪些项（0 起下标）；空数组 = 立刻开始。 */
  after: number[];
}

export type AiTeamLeaderDecision =
  | { action: "assign"; message: string; steps: AiTeamAssignedStep[] }
  | { action: "ask"; message: string }
  | { action: "finish"; message: string };

/** 后一段已经完整包含前一段时只留后一段（任务标题常是描述开头被截断出来的前缀）。 */
function mergeTaskTexts(title: string, description: string): string {
  const head = title.trim();
  const tail = description.trim();
  if (!head) return tail;
  if (!tail) return head;
  if (tail.includes(head)) return tail;
  if (head.includes(tail)) return head;
  return `${head}\n\n${tail}`;
}

/**
 * 团队这一轮要做的事。
 * 指派框 / 群聊里刚输入的文字就是本轮任务，不再把任务卡上的旧描述静默拼进去。
 * 没有单独输入时（创建任务后立刻交给团队）才用标题 + 描述，标题已被描述覆盖时不重复。
 */
export function buildAiTeamObjective(
  task: { title: string; description: string },
  note?: string,
): string {
  const assignment = note?.trim() ?? "";
  if (assignment) {
    const title = task.title.trim();
    return title && !assignment.includes(title) ? `任务：${title}\n\n${assignment}` : assignment;
  }
  return mergeTaskTexts(task.title, task.description) || "完成这张任务";
}

export function leaderOf(team: AiTeam): AiTeamMember {
  return team.members.find((member) => member.isLeader) ?? team.members[0]!;
}

export function workersOf(team: AiTeam): AiTeamMember[] {
  // A single employee or explicitly @-selected coordinator retains their own professional duty.
  return team.members.length === 1 || team.allowLeaderWork ? team.members : team.members.filter((member) => !member.isLeader);
}

/** 每步的约定报告文件（相对 cwd）。所有 CLI 都能写文件，因此是通用的交接方式。 */
export function aiTeamReportPath(runId: string, seq: number, kind: "leader" | "work", memberId: string): string {
  const name = kind === "leader" ? `${seq}-leader.json` : `${seq}-${memberId}.md`;
  return `${AI_TEAM_REPORT_DIR}/${runId}/${name}`;
}

/**
 * 交接文件（相对 cwd）：上一批步骤的报告全文汇总，服务端在派发前写好，
 * 下一步的提示词只给这条路径，让执行者自己去读，不再把报告贴进提示词。
 */
export function aiTeamHandoffPath(runId: string, seq: number, kind: "leader" | "work"): string {
  return `${AI_TEAM_REPORT_DIR}/${runId}/handoff-${seq}-${kind}.md`;
}

/**
 * 群聊续跑的上下文文件（相对 cwd）：用户在同一个群聊里接着说话时，服务端把之前几轮的
 * 步骤摘要与群聊原文写在这里，新一轮的负责人与成员先读它再动手，不从零重来。
 * 文件名由运行 id 决定，所以在库里不用额外记一列；「文件在不在」就是「是不是续跑」。
 */
export function aiTeamChatHistoryPath(runId: string): string {
  return `${AI_TEAM_REPORT_DIR}/${runId}/chat-history.md`;
}

const STEP_STATUS_LABEL: Record<AiTeamStep["status"], string> = {
  queued: "排队",
  running: "进行中",
  done: "完成",
  failed: "失败",
  skipped: "已跳过",
};

const RUN_STATUS_LABEL: Record<AiTeamRunStatus, string> = {
  running: "进行中",
  awaiting_approval: "等你批准计划",
  waiting_user: "等你回复",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** 一条待交接的上游步骤：提示词里只给元信息，正文进交接文件。 */
export interface AiTeamHandoffStep {
  seq: number;
  title: string;
  memberName: string;
  status: AiTeamStep["status"];
  reportPath: string;
}

/** 交接文件正文用的条目：元信息 + 报告全文。 */
export interface AiTeamHandoffEntry extends AiTeamHandoffStep {
  report: string;
}

/** 交接文件正文（Markdown）。纯函数，便于单测。 */
export function renderHandoffFile(entries: AiTeamHandoffEntry[], generatedAt: string): string {
  const lines = [
    "# 上游交接",
    "",
    `> 生成时间：${generatedAt}。下面是上游步骤的原始报告，动手前请读完与本次相关的部分。`,
    "",
  ];
  for (const entry of entries) {
    lines.push(`## 第${entry.seq}步 · ${entry.memberName} · ${entry.title} · ${STEP_STATUS_LABEL[entry.status]}`);
    lines.push(`报告文件：${entry.reportPath}`, "", entry.report.trim() || "（没有报告）", "");
  }
  return lines.join("\n");
}

/** 提示词里只列一行元信息；正文在交接文件里，避免把长报告整段塞进上下文。 */
function handoffStepLine(step: AiTeamHandoffStep): string {
  return `- 第${step.seq}步 · ${step.memberName} · ${step.title} · ${STEP_STATUS_LABEL[step.status]} · 报告文件：${step.reportPath}`;
}

/** 成员步骤的上游交接（依赖步骤）；没有依赖时为 null。 */
export interface AiTeamUpstream {
  handoffPath: string;
  steps: AiTeamHandoffStep[];
}

/** 群聊上下文文件里的一段「之前几轮运行」摘要：只列步骤与状态，报告正文通过群聊文件引用读取。 */
export interface AiTeamHistoryRun {
  status: AiTeamRunStatus;
  steps: Array<{ seq: number; memberName: string; title: string; status: AiTeamStep["status"] }>;
}

/** 上下文文件里单条发言最多占的字节；整个文件另有总预算。 */
const CHAT_HISTORY_MAX_BYTES = 64 * 1024;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function historyTurnSpeaker(turn: ConversationTurn): string {
  if (turn.role === "user") return "用户";
  if (!turn.author) return "团队";
  return turn.author.leader ? `${turn.author.name}（负责人）` : turn.author.name;
}

/** 一条群聊发言；提示行（notice）压成引用行，没有文字内容返回 null。 */
function renderHistoryTurn(turn: ConversationTurn): string | null {
  const text = turn.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
  if (!text) return null;
  return turn.notice ? `> ${historyTurnSpeaker(turn)}：${text}` : `**${historyTurnSpeaker(turn)}**\n${text}`;
}

/** 从最新往回取到预算上限；一条都放不下时至少留最后一条，否则续跑就没有上下文可读。 */
function tailWithinBudget(blocks: string[], budget: number): string[] {
  let used = 0;
  let start = blocks.length;
  while (start > 0) {
    const size = byteLength(blocks[start - 1]!) + 2;
    if (used + size > budget) break;
    used += size;
    start -= 1;
  }
  if (start === blocks.length && blocks.length > 0) start = blocks.length - 1;
  return blocks.slice(start);
}

/**
 * 群聊续跑的交接文件（Markdown，纯函数便于单测）：先列之前几轮的步骤摘要（含上一轮没做完的），
 * 再给群聊原文；原文只留最近的这一段，超预算时从最早处丢并注明。
 */
export function renderChatHistoryFile(input: {
  runs: AiTeamHistoryRun[];
  turns: ConversationTurn[];
  generatedAt: string;
  maxBytes?: number;
}): string {
  const lines = [
    "# 本群聊之前的记录",
    "",
    `> 生成时间：${input.generatedAt}。用户在这个群聊里接着提了新要求，动手前先读完这份记录。`,
    "> 已经完成的部分不要重做；上一轮没做完的步骤见下面的运行摘要，报告正文请读取群聊里的报告文件。",
    "",
  ];
  if (input.runs.length > 0) {
    lines.push("## 之前几轮运行", "");
    for (const run of input.runs) {
      lines.push(`- 状态：${RUN_STATUS_LABEL[run.status]}`);
      for (const step of run.steps) {
        lines.push(`  - 第${step.seq}步 · ${step.memberName} · ${step.title} · ${STEP_STATUS_LABEL[step.status]}`);
      }
    }
    lines.push("");
  }
  const head = `${lines.join("\n")}\n## 群聊原文\n\n`;
  // 预算只看群聊原文这一段；摘要与截断说明不参与取舍。
  const budget = Math.max(0, (input.maxBytes ?? CHAT_HISTORY_MAX_BYTES) - byteLength(head) - 64);
  const blocks = input.turns.map(renderHistoryTurn).filter((block): block is string => block !== null);
  const kept = tailWithinBudget(blocks, budget);
  const dropped = blocks.length - kept.length;
  return [
    head.trimEnd(),
    dropped > 0 ? `> （更早的 ${dropped} 条发言已省略）` : "",
    ...kept,
    "",
  ].filter((part) => part !== "").join("\n\n");
}

/**
 * 一轮提示词：`system` 交给 CLI 的系统提示通道（角色、规则、回复格式、交接文件的用法），
 * `message` 是这一轮的用户消息（目标、指派、文件路径）。
 * provider 支持系统提示时一律走 `system`：规则不伪装成用户发言，也不每轮重复。
 */
export interface AiTeamPrompt {
  system: string;
  message: string;
}

/** 角色中文标签；any / 缺省不显示。 */
const TEAM_ROLE_LABELS: Partial<Record<TeamMemberRole, string>> = {
  plan: "制定计划",
  work: "干活实现",
  verify: "验收测试",
};

/** `default` 哨兵在提示词里怎么写：换成服务端为该 CLI 配置的默认模型名；没配就退回「默认」。 */
export type AiTeamModelNameResolver = (provider: WandTaskAgent["provider"]) => string;

function memberLine(member: AiTeamMember, resolveModel?: AiTeamModelNameResolver): string {
  // 只渲染首选候选（§3.6）；备用候选不进提示词，降级由系统处理。
  const preferred = memberAgents(member)[0] ?? member.agent;
  const configured = preferred.model === "default" ? resolveModel?.(preferred.provider)?.trim() ?? "" : "";
  // `default` 不是模型名，写真正会用的那个（拿不到名字才写「默认」）。
  const model = preferred.model === "default" ? configured || "默认" : preferred.model;
  const role = member.role ? TEAM_ROLE_LABELS[member.role] : undefined;
  const duty = member.duty.trim().replace(/\s+/g, " ") || "（未填写）";
  const parts = [`id: ${member.id}`, `名字: ${member.name}`];
  if (role) parts.push(`角色: ${role}`);
  parts.push(`CLI: ${preferred.provider}/${model}/${preferred.thinkingEffort}`, `职责: ${duty}`);
  return `- ${parts.join(" | ")}`;
}

function leaderReplyFormat(): string[] {
  return [
    "## 回复方式（必须遵守）",
    `每轮消息末尾都给出这一轮的报告文件（标签「${ROUND_REPORT_LABEL}」）；把决定写成 JSON 写入该文件，写完只简短回复「已写入」，不要在消息里复述计划。`,
    "格式三选一：",
    '{"action":"assign","message":"给用户看的一句话说明","steps":[{"member":"成员 id","title":"简短标题","instructions":"具体要做什么、做到什么程度"}]}',
    '{"action":"ask","message":"要问用户的问题"}',
    '{"action":"finish","message":"最终总结：完成了什么、改了哪些文件、验收结论、遗留问题"}',
    "",
    "steps 里 `after` 写这一步要等哪几步完成（写本次 steps 内的序号，从 1 开始）：",
    "- 省略 after：等上一步完成后开始（顺序执行）；",
    "- \"after\": []：立刻开始，可以和别的成员并行；",
    "- \"after\": [1, 2]：等第 1、2 步都做完再开始。",
    // 依据就是被依赖步骤的产物（设计 v2.1 规则 7）：群里显示成「依据：第 N 步「标题」的产物」，
    // 所以 after 要指向真正的上游，不要挂着不相关的步骤。
    "- 这个依赖关系会在群里显示成「依据：第 N 步「标题」的产物」，所以 after 只能指向这一步真正要接着做的上游步骤。",
    "",
    "instructions 的写法要求：",
    "- 实现步骤的 instructions 必须列出允许改动的文件/目录范围；",
    "- 验收步骤的 instructions 必须以「验收标准」清单收尾。",
  ];
}

function teamInstructions(team: AiTeam): string[] {
  const text = team.instructions?.trim();
  return text ? ["", "## 协作指令", text] : [];
}

/** 目标与用户补充都是用户原话（常带口述笔误），别按字面较真。 */
const OBJECTIVE_INTENT_NOTE = "目标与用户补充都是用户原话，可能带口述笔误（例如把 CLI 写成 ci），按用户意图理解，不要照字面复述。";

/**
 * 交接文件怎么用，写在系统提示里（消息里只给路径，会话级规则只说一次）。
 * 负责人用它决定下一步，成员用它接着上游干活。
 */
function handoffRules(audience: "leader" | "member"): string[] {
  return audience === "leader"
    ? [
      "## 交接文件（消息里出现下列标签时，先读文件再动手）",
      `- ${HANDOFF_LABEL}：上一批步骤的报告全文汇总，先读它再决定下一步；不要凭标题猜成员做了什么，也不要让他们把报告复述进消息里。`,
      `- ${CHAT_HISTORY_LABEL}：用户是在这个群聊里接着提要求；先读它，已经做完的不要重做，上一轮没做完的接着做。`,
      "",
    ]
    : [
      "## 交接文件（消息里出现下列标签时，先读文件再动手）",
      `- ${HANDOFF_LABEL}：上游步骤的报告全文汇总，先读它再开始本步骤；不要猜上游做了什么，也不要重复劳动。`,
      `- ${CHAT_HISTORY_LABEL}：用户是在这个群聊里接着提要求；先读它，在已有改动的基础上继续，已经完成的部分不要重做。`,
      "",
    ];
}

function leaderSystemPrompt(run: AiTeamRun, resolveModel?: AiTeamModelNameResolver): string {
  const leader = leaderOf(run.team);
  const employeePrompt = teamMemberEmployee(leader)?.prompt;
  return [
    ...(employeePrompt ? [employeePrompt] : []),
    `你是 AI 团队「${run.team.name}」的负责人（${leader.name}）。`,
    `你的专业职责：${leader.duty.trim() || "拆分任务、派工、根据报告决定下一步。"}`,
    ...(run.team.allowLeaderWork ? ["用户通过 @ 指定你为本轮负责人：协调职责是拆分任务、按群成员的专业职责派工、收集报告并汇总；不代表所有工作都由你执行。"] : []),
    "",
    "## 成员（只能把工作派给下列成员；id 必须原样使用）",
    "成员的名单行只列首选执行配置；执行配置由系统按候选顺序自动降级，你只按成员能力分派，不操心模型可用性。",
    ...workersOf(run.team).map((member) => memberLine(member, resolveModel)),
    ...teamInstructions(run.team),
    "",
    "## 工作方式",
    run.team.members.length === 1
      ? "- 本群只有你一位员工：规划阶段只制定计划，work 步骤使用你的同一 member id。执行阶段会在独立的阶段会话里工作并交付。"
      : run.team.allowLeaderWork
        ? "- 规划阶段只负责拆分、派工和汇总。属于你专业职责的工作可派给自己的 member id，系统会用独立 work 会话执行；其余工作交给职责匹配的成员，不能包办，也不为了全员发言重复派工。"
        : "- 你不直接改代码：你负责拆分任务、派工，并根据成员报告决定下一步。",
    `- 每次只安排接下来要做的几步（1–${AI_TEAM_MAX_ASSIGN_STEPS} 步）。互不依赖的工作派给不同成员可以并行；所有在跑的步骤结束后，我会把报告交回给你。`,
    "- 并行成员共用同一个工作目录，不要让两个人同时改同一批文件。",
    run.team.members.length === 1
      ? "- 可以自测，但不能声称独立交叉验收。任务需要另一人验收时，等待用户明确邀请/确认，不虚构成员。"
      : "- 实现与验收交给不同成员，不要让同一个成员验收自己的工作。",
    "- 派工优先按角色：制定计划给 plan 成员，实现给 work 成员，验收给 verify 成员；没标角色的成员视为 any。",
    "- 同时按成员的专业职责选人并遵守边界（例如设计成员只出设计，不改产品代码），不能因为某人是负责人就把所有工作交给他。",
    "- 同一成员同一时间只有一个步骤；互不相干的步骤并行派出，有先后关系的用 after 声明。",
    "- 需要用户拍板时就提问，不要猜。",
    `- ${OBJECTIVE_INTENT_NOTE}`,
    "",
    ...handoffRules("leader"),
    ...leaderReplyFormat(),
  ].join("\n");
}

function memberSystemPrompt(run: AiTeamRun, member: AiTeamMember): string {
  const employeePrompt = teamMemberEmployee(member)?.prompt;
  return [
    ...(employeePrompt ? [employeePrompt] : []),
    `你是 AI 团队「${run.team.name}」的成员（${member.name}）。`,
    `你的职责：${member.duty.trim() || "（未填写）"}`,
    ...teamInstructions(run.team),
    "",
    "## 工作方式",
    "- 只做本轮消息里指派给你的这一步，不要顺手改别的。",
    "- 不要 git commit / push。",
    "- 你的发言会以群聊气泡出现，署名是你的名字；报告写进报告文件，完成后服务端会以文件卡片发到群聊，不要再复述报告正文。",
    "",
    ...handoffRules("member"),
    "## 报告约定",
    `每轮消息末尾都给出这一轮的报告文件（标签「${ROUND_REPORT_LABEL}」）；完成后把报告写进该文件（Markdown）：`,
    "第一行写 `状态: 完成`、`状态: 受阻` 或 `状态: 失败`，然后写做了什么、改了哪些文件、怎么验证的、还有什么问题。",
  ].join("\n");
}

/** 本轮报告文件的引用行；怎么用写在系统提示里（见 `leaderReplyFormat` / 「报告约定」）。 */
function reportLine(reportPath: string): string {
  return `${ROUND_REPORT_LABEL}：${reportPath}`;
}

/** 会话是新建的时候才需要补目标：老会话的上下文里已经有目标了。 */
function objectiveBlock(run: AiTeamRun, fresh: boolean): string[] {
  // 标签内联而不是单独的 `## 团队目标` 行：团队消息也会被会话标题 / 迭代提示词记录取首行，
  // 单独一行的话标题会退化成「团队目标」这个空壳。
  return fresh ? [`团队目标：${run.objective}`, ""] : [];
}

/**
 * 续跑（用户在同一个群聊里接着说话）的上下文文件（见 `aiTeamChatHistoryPath`）：
 * 消息只给路径，「先读它、别重做已完成的」写在系统提示的「交接文件」段。
 */
function chatHistoryBlock(path: string | null | undefined): string[] {
  return path ? [`${CHAT_HISTORY_LABEL}：${path}`, ""] : [];
}

/** `chatHistoryPath` 有值时说明这一轮是同一个群聊的续跑（见 `aiTeamChatHistoryPath`）。 */
export function buildLeaderKickoffPrompt(
  run: AiTeamRun,
  reportPath: string,
  fresh: boolean,
  chatHistoryPath?: string | null,
  resolveModel?: AiTeamModelNameResolver,
): AiTeamPrompt {
  return {
    system: leaderSystemPrompt(run, resolveModel),
    message: [
      ...objectiveBlock(run, fresh),
      ...chatHistoryBlock(chatHistoryPath),
      reportLine(reportPath),
    ].join("\n"),
  };
}

export interface AiTeamFinishedStepSummary {
  step: AiTeamStep;
  memberName: string;
}

export function buildLeaderFollowupPrompt(
  run: AiTeamRun,
  finished: AiTeamFinishedStepSummary[],
  reportPath: string,
  userNote: string | undefined,
  fresh: boolean,
  handoffPath?: string | null,
  chatHistoryPath?: string | null,
  resolveModel?: AiTeamModelNameResolver,
): AiTeamPrompt {
  // 续跑上下文只在新建的负责人会话里补一次：会话复用的时候，kickoff 那一轮已经给过路径。
  const lines: string[] = [...objectiveBlock(run, fresh), ...chatHistoryBlock(fresh ? chatHistoryPath : null)];
  if (finished.length > 0) {
    lines.push("## 已结束的步骤", "");
    for (const { step, memberName } of finished) {
      lines.push(handoffStepLine({ ...step, memberName }));
    }
    if (handoffPath) lines.push("", `${HANDOFF_LABEL}：${handoffPath}`);
    lines.push("");
  }
  if (userNote?.trim()) lines.push("## 用户补充", userNote.trim(), "");
  lines.push(reportLine(reportPath));
  return { system: leaderSystemPrompt(run, resolveModel), message: lines.join("\n") };
}

export function buildLeaderFormatRetryPrompt(
  run: AiTeamRun,
  error: string,
  reportPath: string,
  fresh: boolean,
  chatHistoryPath?: string | null,
  resolveModel?: AiTeamModelNameResolver,
): AiTeamPrompt {
  return {
    system: leaderSystemPrompt(run, resolveModel),
    message: [
      ...objectiveBlock(run, fresh),
      ...chatHistoryBlock(fresh ? chatHistoryPath : null),
      `上次的回复没能解析：${error}`,
      "",
      reportLine(reportPath),
    ].join("\n"),
  };
}

/**
 * fresh=false 时成员会话已有上下文，省掉目标段落。`upstream` 有值时只给交接文件路径与
 * 各步报告文件，不在提示词里复述上游报告正文（上一个成员的信息走文件交接）。
 */
export function buildMemberPrompt(
  run: AiTeamRun,
  step: AiTeamStep,
  member: AiTeamMember,
  fresh: boolean,
  upstream?: AiTeamUpstream | null,
  chatHistoryPath?: string | null,
): AiTeamPrompt {
  const lines = [
    ...objectiveBlock(run, fresh),
    // 续跑上下文只在新建的成员会话里补一次：成员这一轮以前的信息都在文件里。
    ...chatHistoryBlock(fresh ? chatHistoryPath : null),
    `## 本步骤：${step.title}`,
    step.instructions,
    "",
  ];
  if (upstream && upstream.steps.length > 0) {
    lines.push("## 上游交接", "");
    for (const item of upstream.steps) lines.push(handoffStepLine(item));
    lines.push("", `${HANDOFF_LABEL}：${upstream.handoffPath}`, "");
  }
  lines.push(reportLine(step.reportPath));
  return { system: memberSystemPrompt(run, member), message: lines.join("\n") };
}

/** 从 start 处的 `{` 找到配对的 `}`（跳过字符串里的括号）。 */
function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractDecisionObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = balancedObjectEnd(text, start);
    if (end < 0) return null;
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value) && "action" in value) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 继续尝试下一个 `{`：前面可能是正文里的花括号。
    }
  }
  return null;
}

function resolveMember(team: AiTeam, ref: unknown): AiTeamMember | null {
  if (typeof ref !== "string") return null;
  const key = ref.trim().toLowerCase();
  if (!key) return null;
  const workers = workersOf(team);
  return workers.find((member) => member.id.toLowerCase() === key)
    ?? workers.find((member) => member.name.trim().toLowerCase() === key)
    ?? null;
}

export function parseLeaderDecision(
  text: string,
  team: AiTeam,
): { ok: true; decision: AiTeamLeaderDecision } | { ok: false; error: string } {
  const raw = extractDecisionObject(text);
  if (!raw) return { ok: false, error: "没有找到包含 action 字段的 JSON 对象。" };
  const action = raw.action;
  if (typeof raw.message !== "string") return { ok: false, error: "message 必须是字符串。" };
  const message = raw.message.trim().slice(0, MESSAGE_MAX);
  if (action === "ask" || action === "finish") {
    if (!message) return { ok: false, error: "message 不能为空。" };
    return { ok: true, decision: { action, message } };
  }
  if (action !== "assign") return { ok: false, error: "action 只能是 assign / ask / finish。" };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { ok: false, error: "assign 需要至少一个 steps 项。" };
  }
  if (raw.steps.length > AI_TEAM_MAX_ASSIGN_STEPS) {
    return { ok: false, error: `一次最多安排 ${AI_TEAM_MAX_ASSIGN_STEPS} 步。` };
  }
  const steps: AiTeamAssignedStep[] = [];
  for (const [index, item] of raw.steps.entries()) {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const member = resolveMember(team, entry.member);
    if (!member) {
      return { ok: false, error: `第 ${index + 1} 步的 member「${String(entry.member ?? "")}」不是可派工的成员 id。` };
    }
    const title = typeof entry.title === "string" ? entry.title.trim().slice(0, TITLE_MAX) : "";
    const instructions = typeof entry.instructions === "string" ? entry.instructions.trim().slice(0, INSTRUCTIONS_MAX) : "";
    if (!title) return { ok: false, error: `第 ${index + 1} 步缺少 title。` };
    if (!instructions) return { ok: false, error: `第 ${index + 1} 步缺少 instructions。` };
    let after: number[];
    if (entry.after === undefined || entry.after === null) {
      after = index > 0 ? [index - 1] : [];
    } else if (Array.isArray(entry.after)) {
      after = [];
      for (const ref of entry.after) {
        const position = Number(ref);
        if (!Number.isInteger(position) || position < 1 || position > index) {
          return { ok: false, error: `第 ${index + 1} 步的 after 只能引用它前面的步骤序号（1–${index}）。` };
        }
        if (!after.includes(position - 1)) after.push(position - 1);
      }
    } else {
      return { ok: false, error: `第 ${index + 1} 步的 after 必须是数组。` };
    }
    steps.push({ memberId: member.id, title, instructions, after });
  }
  return { ok: true, decision: { action: "assign", message, steps } };
}
