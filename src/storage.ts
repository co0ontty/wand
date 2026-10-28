import crypto from "node:crypto";
import { chmodSync,mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScheduledTaskRepository } from "./storage-schedules.js";
import { openStorageDatabase } from "./storage-schema.js";
import type { ConnectorMeta } from "./storage/mappers.js";
import { parseWandTaskAgent } from "./storage/mappers.js";
export * from "./storage/internal.js";
import { ConversationRepository } from "./storage/conversations-repository.js";
import { DingTalkRepository } from "./storage/dingtalk-repository.js";
import { ApnsRepository } from "./storage/apns-repository.js";
import { LiveActivityRepository } from "./storage/live-activity-repository.js";
import { ConversationOrganizationRepository } from "./storage/conversation-organization-repository.js";
import { PreferencesRepository } from "./storage/preferences-repository.js";
import { WorkspaceRepository } from "./storage/workspaces-repository.js";
import { TaskRepository } from "./storage/tasks-repository.js";
import { SecretsRepository } from "./storage/secrets-repository.js";
import { KnowledgeRepository } from "./storage/knowledge-repository.js";
import { EmployeeRepository } from "./storage/employees-repository.js";
import { UserMemoryRepository } from "./storage/user-memory-repository.js";
import { AiTeamRepository } from "./storage/ai-teams-repository.js";
import { MissionRepository } from "./storage/missions-repository.js";
import { SessionRepository } from "./storage/sessions-repository.js";
import { UploadRepository } from "./storage/uploads-repository.js";
import { FeedbackRepository } from "./storage/feedback-repository.js";
export { parseWandTaskAgent };
export type { ConnectorMeta };
export { ensureDatabaseFile } from "./storage-schema.js";

/** Public methods of a repository, forwarded from WandStorage at runtime and typed here. */
type RepositoryMethods<T> = Pick<T, { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T]>;

export interface WandStorage extends
  RepositoryMethods<DingTalkRepository>,
  RepositoryMethods<ConversationRepository>,
  RepositoryMethods<ConversationOrganizationRepository>,
  RepositoryMethods<PreferencesRepository>,
  RepositoryMethods<WorkspaceRepository>,
  RepositoryMethods<TaskRepository>,
  RepositoryMethods<SecretsRepository>,
  RepositoryMethods<EmployeeRepository>,
  RepositoryMethods<KnowledgeRepository>,
  RepositoryMethods<UserMemoryRepository>,
  RepositoryMethods<AiTeamRepository>,
  RepositoryMethods<MissionRepository>,
  RepositoryMethods<SessionRepository>,
  RepositoryMethods<UploadRepository>,
  RepositoryMethods<FeedbackRepository> {}

export class WandStorage {
  readonly dingtalk: DingTalkRepository;
  readonly apns: ApnsRepository;
  readonly liveActivities: LiveActivityRepository;
  readonly conversations: ConversationRepository;
  readonly conversationOrganizations: ConversationOrganizationRepository;
  readonly preferences: PreferencesRepository;
  readonly workspaces: WorkspaceRepository;
  readonly tasks: TaskRepository;
  readonly secrets: SecretsRepository;
  readonly employees: EmployeeRepository;
  readonly knowledge: KnowledgeRepository;
  readonly userMemory: UserMemoryRepository;
  readonly aiTeams: AiTeamRepository;
  readonly missions: MissionRepository;
  readonly sessions: SessionRepository;
  readonly uploads: UploadRepository;
  readonly feedback: FeedbackRepository;
  private readonly closeListeners = new Set<() => void>();
  private readonly taskTitleListeners = new Set<() => void>();
  private titleNoticePending = false;
  private closed = false;
  private readonly projectionEpoch = crypto.randomUUID();

  /** Exact conservative invalidation: own writes + writes from other SQLite connections. */
  projectionRevision(): string {
    const own = this.db.prepare("SELECT total_changes() AS revision").get() as { revision: number };
    const external = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    return `${this.projectionEpoch}:${own.revision}:${external.data_version}`;
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  onTaskTitleChange(listener: () => void): () => void {
    this.taskTitleListeners.add(listener);
    return () => { this.taskTitleListeners.delete(listener); };
  }

  /** Coalesce synchronous writes; observers read only after the transaction settles. */
  notifyTaskTitleChange(): void {
    if (this.closed || this.titleNoticePending || !this.taskTitleListeners.size) return;
    this.titleNoticePending = true;
    queueMicrotask(() => {
      this.titleNoticePending = false;
      if (this.closed) return;
      for (const listener of this.taskTitleListeners) {
        try { listener(); } catch { console.error("[WandTask] title change observer failed"); }
      }
    });
  }

  private readonly db: DatabaseSync;
  private readonly schedules: ScheduledTaskRepository;
  private readonly dbPath: string;
  memoryCapture = { enabled: true, revision: 0 };
  private txDepth = 0;
  private savepointSeq = 0;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.dbPath = dbPath;
    this.db = openStorageDatabase(dbPath);
    this.dingtalk = new DingTalkRepository(this.db);
    this.apns = new ApnsRepository(this.db, this);
    this.liveActivities = new LiveActivityRepository(this.db, this);
    this.conversations = new ConversationRepository(this.db, this);
    this.conversationOrganizations = new ConversationOrganizationRepository(this.db);
    this.preferences = new PreferencesRepository(this.db, this);
    this.workspaces = new WorkspaceRepository(this.db, this);
    this.tasks = new TaskRepository(this.db, this);
    this.secrets = new SecretsRepository(this.db, this);
    this.employees = new EmployeeRepository(this.db, this);
    this.knowledge = new KnowledgeRepository(this.db, this);
    this.userMemory = new UserMemoryRepository(this.db, this);
    this.aiTeams = new AiTeamRepository(this.db, this);
    this.missions = new MissionRepository(this.db, this);
    this.sessions = new SessionRepository(this.db, this);
    this.uploads = new UploadRepository(this.db, this);
    this.feedback = new FeedbackRepository(this.db, this);
    this.schedules = new ScheduledTaskRepository(this.db, action => this.transaction(action));
    this.secrets.openVault();
    const brokenLinks = this.integrityReport().filter((item) => item.count > 0);
    if (brokenLinks.length > 0) console.warn(`[wand] ownership links with no target: ${JSON.stringify(brokenLinks)}`);
    this.ensureDefaultPasswordVault();
    const memory = this.getUserMemoryState();
    this.memoryCapture = { enabled: memory.enabled, revision: memory.revision };
    this.ensureDefaultWandMilestone();
  }

  directory(): string {
    return path.dirname(this.dbPath);
  }

  databasePath(): string {
    return this.dbPath;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) {
      try { listener(); } catch { /* finish closing other storage-owned consumers */ }
    }
    this.closeListeners.clear();
    this.taskTitleListeners.clear();
    this.db.close();
  }

  /**
   * Run a synchronous group of storage operations atomically. Nested calls use
   * SAVEPOINTs, so an inner failure rolls back only its own work and the caller
   * decides whether to propagate it.
   */
  transaction<T>(action: () => T): T {
    if (this.txDepth > 0) {
      const name = `wand_sp_${++this.savepointSeq}`;
      this.db.exec(`SAVEPOINT ${name}`);
      this.txDepth += 1;
      try {
        const result = action();
        this.db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        try { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); } catch { /* preserve the original error */ }
        throw error;
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    } finally {
      this.txDepth = 0;
    }
  }

  /**
   * Read-only probe for ownership links SQLite does not enforce (the schema has no
   * FK constraints on these legacy tables). Reports counts; never repairs.
   */
  integrityReport(): Array<{ check: string; count: number }> {
    const checks: Array<[string, string]> = [
      ["wand_tasks.workspace_task_id -> workspace_tasks",
        "SELECT COUNT(*) AS n FROM wand_tasks c WHERE c.workspace_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_tasks w WHERE w.id = c.workspace_task_id)"],
      ["command_sessions.workspace_task_id -> workspace_tasks",
        "SELECT COUNT(*) AS n FROM command_sessions s WHERE s.workspace_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_tasks w WHERE w.id = s.workspace_task_id)"],
      ["workspace_tasks.workspace_id -> workspaces",
        "SELECT COUNT(*) AS n FROM workspace_tasks w WHERE NOT EXISTS (SELECT 1 FROM workspaces p WHERE p.id = w.workspace_id)"],
      ["wand_task_sessions.task_id -> wand_tasks",
        "SELECT COUNT(*) AS n FROM wand_task_sessions l WHERE NOT EXISTS (SELECT 1 FROM wand_tasks c WHERE c.id = l.task_id)"],
      ["wand_task_sessions.session_id -> command_sessions",
        "SELECT COUNT(*) AS n FROM wand_task_sessions l WHERE NOT EXISTS (SELECT 1 FROM command_sessions s WHERE s.id = l.session_id)"],
      ["wand_tasks.workspace_id -> workspaces",
        "SELECT COUNT(*) AS n FROM wand_tasks c WHERE c.workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces p WHERE p.id = c.workspace_id)"],
    ];
    return checks.map(([check, sql]) => ({ check, count: (this.db.prepare(sql).get() as { n: number }).n }));
  }

  // ============ Persistent employee schedules ============

  listScheduledTasks(...args: Parameters<ScheduledTaskRepository["listScheduledTasks"]>): ReturnType<ScheduledTaskRepository["listScheduledTasks"]> {
    return this.schedules.listScheduledTasks(...args);
  }

  listDueScheduledTasks(...args: Parameters<ScheduledTaskRepository["listDueScheduledTasks"]>): ReturnType<ScheduledTaskRepository["listDueScheduledTasks"]> {
    return this.schedules.listDueScheduledTasks(...args);
  }

  getScheduledTask(...args: Parameters<ScheduledTaskRepository["getScheduledTask"]>): ReturnType<ScheduledTaskRepository["getScheduledTask"]> {
    return this.schedules.getScheduledTask(...args);
  }

  createScheduledTask(...args: Parameters<ScheduledTaskRepository["createScheduledTask"]>): ReturnType<ScheduledTaskRepository["createScheduledTask"]> {
    return this.schedules.createScheduledTask(...args);
  }

  updateScheduledTask(...args: Parameters<ScheduledTaskRepository["updateScheduledTask"]>): ReturnType<ScheduledTaskRepository["updateScheduledTask"]> {
    return this.schedules.updateScheduledTask(...args);
  }

  claimScheduledTaskRun(...args: Parameters<ScheduledTaskRepository["claimScheduledTaskRun"]>): ReturnType<ScheduledTaskRepository["claimScheduledTaskRun"]> {
    return this.schedules.claimScheduledTaskRun(...args);
  }

  saveScheduledTaskRun(...args: Parameters<ScheduledTaskRepository["saveScheduledTaskRun"]>): ReturnType<ScheduledTaskRepository["saveScheduledTaskRun"]> {
    return this.schedules.saveScheduledTaskRun(...args);
  }

  getScheduledTaskRun(...args: Parameters<ScheduledTaskRepository["getScheduledTaskRun"]>): ReturnType<ScheduledTaskRepository["getScheduledTaskRun"]> {
    return this.schedules.getScheduledTaskRun(...args);
  }

  listOpenScheduledTaskRuns(...args: Parameters<ScheduledTaskRepository["listOpenScheduledTaskRuns"]>): ReturnType<ScheduledTaskRepository["listOpenScheduledTaskRuns"]> {
    return this.schedules.listOpenScheduledTaskRuns(...args);
  }

  getOpenScheduledTaskRunsForSession(...args: Parameters<ScheduledTaskRepository["getOpenScheduledTaskRunsForSession"]>): ReturnType<ScheduledTaskRepository["getOpenScheduledTaskRunsForSession"]> {
    return this.schedules.getOpenScheduledTaskRunsForSession(...args);
  }

  listScheduledTaskRuns(...args: Parameters<ScheduledTaskRepository["listScheduledTaskRuns"]>): ReturnType<ScheduledTaskRepository["listScheduledTaskRuns"]> {
    return this.schedules.listScheduledTaskRuns(...args);
  }

  listScheduledTaskRunFacts(...args: Parameters<ScheduledTaskRepository["listScheduledTaskRunFacts"]>): ReturnType<ScheduledTaskRepository["listScheduledTaskRunFacts"]> {
    return this.schedules.listScheduledTaskRunFacts(...args);
  }

  countInvalidScheduledTaskRunDates(...args: Parameters<ScheduledTaskRepository["countInvalidScheduledTaskRunDates"]>): ReturnType<ScheduledTaskRepository["countInvalidScheduledTaskRunDates"]> {
    return this.schedules.countInvalidScheduledTaskRunDates(...args);
  }

  latestScheduledTaskRun(...args: Parameters<ScheduledTaskRepository["latestScheduledTaskRun"]>): ReturnType<ScheduledTaskRepository["latestScheduledTaskRun"]> {
    return this.schedules.latestScheduledTaskRun(...args);
  }

  // ============ Stable conversations (no read-side repair) ============





















  // ============ Config Methods ============




  // ============ Preference Methods ============
  // Preferences 与 getConfigValue/setConfigValue 共用 app_config 表，
  // 区别在于：preference 自动 JSON 序列化/反序列化，并按"未设置时返回 fallback"语义返回。
  // 用于存放 UI 设置面板可改的用户偏好（defaultMode/defaultModel/cardDefaults 等），
  // 与 JSON 配置中的部署期参数（host/port/shell 等）分开。




  // ============ Pi 会话默认设置 ============



  // ============ 首页目录组顺序 ============




  // ============ Session Directory Names ============



  // ============ Workspaces（多标签 / 分屏项目）============

















  // ── Workspace tasks（任务 = 命名 + 独立 worktree + 一组标签）──



























  /** One-time id-based reconciliation; normal reads never create tasks or repair membership. */
  // ── 里程碑（迭代，归属工作区；任务只存 milestoneId）──









  // ============ 迭代提示词记录 ============






  // ============ 会话 → 任务 / 迭代 ============




























  // ============ Browser Extension Password Vault Methods ============











  // ============ Connector Methods ============
  // 第三方服务凭据（GitHub 等）。token 用与密码库同一把 at-rest 密钥加密，
  // 解密只在服务端发生，绝不通过 /api/settings 回传明文。






  // ============ Auth Session Methods ============
  // Tokens are stored as SHA-256 digests (schema v3). Callers keep the raw token; the row key is its hash.






  // ============ Silicon Employees ============

















  // ============ Employee-owned explicit knowledge ============















  // ============ User short-term memory ============












  // ============ AI Teams ============

















  // ============ Missions ============
































}

const REPOSITORY_FORWARDS: ReadonlyArray<readonly [field: string, repository: { readonly prototype: object }]> = [
  ["dingtalk", DingTalkRepository],
  ["conversations", ConversationRepository],
  ["conversationOrganizations", ConversationOrganizationRepository],
  ["preferences", PreferencesRepository],
  ["workspaces", WorkspaceRepository],
  ["tasks", TaskRepository],
  ["secrets", SecretsRepository],
  ["employees", EmployeeRepository],
  ["knowledge", KnowledgeRepository],
  ["userMemory", UserMemoryRepository],
  ["aiTeams", AiTeamRepository],
  ["missions", MissionRepository],
  ["sessions", SessionRepository],
  ["uploads", UploadRepository],
  ["feedback", FeedbackRepository],
];
for (const [field, repository] of REPOSITORY_FORWARDS) {
  for (const name of Object.getOwnPropertyNames(repository.prototype)) {
    if (name === "constructor") continue;
    if (Object.prototype.hasOwnProperty.call(WandStorage.prototype, name)) throw new Error(`WandStorage facade collision: ${name}`);
    // Writable and configurable like class methods, so tests and callers can stub an instance method.
    Object.defineProperty(WandStorage.prototype, name, {
      writable: true,
      configurable: true,
      value: function forwarded(this: Record<string, unknown>, ...args: unknown[]): unknown {
        const target = this[field] as Record<string, (...values: unknown[]) => unknown>;
        return target[name]!(...args);
      },
    });
  }
}
