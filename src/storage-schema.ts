import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STORAGE_MIGRATIONS, type StorageMigration, type StorageMigrationContext } from "./storage/migrations.js";

/** Additive schema only. Domain migrations and transactions remain owned by WandStorage. */
const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'browser-admin',
    scopes TEXT NOT NULL DEFAULT '["admin"]'
  );

  CREATE TABLE IF NOT EXISTS command_sessions (
    id TEXT PRIMARY KEY,
    session_source TEXT NOT NULL DEFAULT 'interactive',
    automation_id TEXT,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    output TEXT NOT NULL,
    pty_output_seq INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    claude_session_id TEXT,
    provider TEXT,
    session_kind TEXT NOT NULL DEFAULT 'pty',
    runner TEXT,
    messages TEXT,
    queued_messages TEXT,
    queued_message_skills TEXT,
    structured_state TEXT,
    resumed_from_session_id TEXT,
    resumed_to_session_id TEXT,
    auto_recovered INTEGER NOT NULL DEFAULT 0,
    worktree_enabled INTEGER NOT NULL DEFAULT 0,
    worktree_info TEXT,
    worktree_merge_status TEXT,
    worktree_merge_info TEXT,
    title TEXT,
    description TEXT,
    session_options TEXT NOT NULL DEFAULT '{"schemaVersion":1}'
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_directory_names (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_vaults (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS connectors (
    provider TEXT PRIMARY KEY,
    token TEXT NOT NULL DEFAULT '',
    api_url TEXT NOT NULL DEFAULT '',
    username TEXT,
    connected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_items (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    username TEXT,
    password TEXT,
    urls TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    fields TEXT NOT NULL DEFAULT '{}',
    tags TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    password_updated_at TEXT,
    FOREIGN KEY(vault_id) REFERENCES password_vaults(id)
  );

  CREATE INDEX IF NOT EXISTS idx_password_items_vault ON password_items(vault_id);
  CREATE INDEX IF NOT EXISTS idx_password_items_type ON password_items(type);
  CREATE INDEX IF NOT EXISTS idx_password_items_updated ON password_items(updated_at);

  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    task_id TEXT,
    milestone_id TEXT,
    base_ref TEXT,
    shared_directories TEXT NOT NULL DEFAULT '[]',
    copy_paths TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mission_attempts (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    session_id TEXT,
    provider TEXT NOT NULL,
    state TEXT NOT NULL,
    branch TEXT,
    worktree_path TEXT,
    base_ref TEXT,
    summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(mission_id) REFERENCES missions(id)
  );

  CREATE TABLE IF NOT EXISTS mission_review_comments (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER,
    side TEXT NOT NULL DEFAULT 'new',
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    sent_at TEXT,
    resolved_at TEXT,
    FOREIGN KEY(mission_id) REFERENCES missions(id),
    FOREIGN KEY(attempt_id) REFERENCES mission_attempts(id)
  );

  CREATE TABLE IF NOT EXISTS agent_activity (
    session_id TEXT PRIMARY KEY,
    mission_id TEXT,
    attempt_id TEXT,
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    provider TEXT,
    cwd TEXT,
    updated_at TEXT NOT NULL,
    read_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_missions_updated ON missions(updated_at);
  CREATE INDEX IF NOT EXISTS idx_mission_attempts_mission ON mission_attempts(mission_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_attempts_session ON mission_attempts(session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_mission_comments_attempt ON mission_review_comments(attempt_id, status);
  CREATE INDEX IF NOT EXISTS idx_agent_activity_state ON agent_activity(state, updated_at);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'project',
    default_provider TEXT,
    layout_json TEXT,
    created_at TEXT NOT NULL,
    last_opened_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_cwd ON workspaces(cwd);
  CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened ON workspaces(last_opened_at);

  CREATE TABLE IF NOT EXISTS workspace_tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    worktree_json TEXT,
    layout_json TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    cwd TEXT,
    milestone_id TEXT,
    created_at TEXT NOT NULL,
    last_opened_at TEXT,
    layout_revision INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace ON workspace_tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_tasks_last_opened ON workspace_tasks(last_opened_at);

  CREATE TABLE IF NOT EXISTS github_issue_bindings (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    PRIMARY KEY (owner, repo, issue_number, session_id),
    FOREIGN KEY (session_id) REFERENCES command_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_github_issue_bindings_session ON github_issue_bindings(session_id);

  CREATE TABLE IF NOT EXISTS wand_milestones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    due_date TEXT,
    workspace_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wand_milestones_created ON wand_milestones(created_at DESC);

  -- 迭代提示词记录：用户在本轮迭代里发过的提示词标题，供 commit message / 汇报类生成复用。
  -- 不建外键：删除迭代只把记录改挂到默认迭代，绝不删记录。
  CREATE TABLE IF NOT EXISTS wand_iteration_prompts (
    id TEXT PRIMARY KEY,
    milestone_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    task_id TEXT,
    repo_key TEXT,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'session',
    consumed_at TEXT,
    consumed_commit TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_iteration ON wand_iteration_prompts(milestone_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_repo ON wand_iteration_prompts(repo_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_session ON wand_iteration_prompts(session_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS wand_tasks (
    id TEXT PRIMARY KEY,
    identifier TEXT,
    workspace_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'none',
    labels_json TEXT NOT NULL DEFAULT '[]',
    due_date TEXT,
    milestone_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    agent_json TEXT,
    execution_subject_json TEXT,
    workspace_task_id TEXT,
    parent_task_id TEXT,
    title_source TEXT,
    auto_title_signature TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wand_tasks_board ON wand_tasks(workspace_id, status, sort_order, updated_at);
  CREATE TABLE IF NOT EXISTS wand_task_sessions (
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    PRIMARY KEY (task_id, session_id),
    FOREIGN KEY (task_id) REFERENCES wand_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES command_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_wand_task_sessions_session ON wand_task_sessions(session_id);

  CREATE TABLE IF NOT EXISTS ai_teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    members_json TEXT NOT NULL,
    require_plan_approval INTEGER NOT NULL DEFAULT 1,
    max_steps INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS silicon_employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    duty TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    agents_json TEXT NOT NULL,
    system_key TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_silicon_employees_archived ON silicon_employees(archived_at);

  CREATE TABLE IF NOT EXISTS employee_knowledge (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES silicon_employees(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (employee_id, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_employee_knowledge_owner ON employee_knowledge(employee_id, created_at);
  CREATE TABLE IF NOT EXISTS employee_knowledge_access (
    token_hash TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES silicon_employees(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_employee_knowledge_access_expiry ON employee_knowledge_access(expires_at);

  CREATE TABLE IF NOT EXISTS decision_access (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decision_access_expiry ON decision_access(expires_at);

  CREATE TABLE IF NOT EXISTS openrouter_free_access (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    selector TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_openrouter_free_access_expiry ON openrouter_free_access(expires_at);

  CREATE TABLE IF NOT EXISTS user_memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    dedup_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_memory_events_created ON user_memory_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_user_memory_events_dedup ON user_memory_events(dedup_key, created_at);
  CREATE TABLE IF NOT EXISTS user_memory_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    source_id INTEGER NOT NULL DEFAULT 0,
    profile_json TEXT
  );
  INSERT OR IGNORE INTO user_memory_state (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS ai_team_runs (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    team_json TEXT NOT NULL,
    objective TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    status_detail TEXT NOT NULL DEFAULT '',
    steps_used INTEGER NOT NULL DEFAULT 0,
    step_limit INTEGER NOT NULL,
    format_retries INTEGER NOT NULL DEFAULT 0,
    plan_approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_team_runs_task ON ai_team_runs(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_team_runs_status ON ai_team_runs(status);

  CREATE TABLE IF NOT EXISTS ai_team_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    member_id TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    report TEXT NOT NULL DEFAULT '',
    report_path TEXT NOT NULL,
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    started_at TEXT,
    ended_at TEXT,
    UNIQUE (run_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_team_steps_session ON ai_team_steps(session_id, status);
`;

/** AI 团队表的后加列；只加不删，历史行取默认值。 */
function ensureAiTeamSchema(db: DatabaseSync): void {
  // silicon_employees 的建表在 INIT_SQL 中；这里只补老库缺的列。
  const teamColumns = new Set((db.prepare("PRAGMA table_info(ai_teams)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!teamColumns.has("instructions")) db.exec("ALTER TABLE ai_teams ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
  const stepColumns = new Set((db.prepare("PRAGMA table_info(ai_team_steps)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!stepColumns.has("depends_on_json")) db.exec("ALTER TABLE ai_team_steps ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'");
  const runColumns = new Set((db.prepare("PRAGMA table_info(ai_team_runs)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!runColumns.has("chat_session_id")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN chat_session_id TEXT");
  if (!runColumns.has("pending_notes_json")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN pending_notes_json TEXT NOT NULL DEFAULT '[]'");
  // v2 多候选降级：步骤实际候选与跳过记录（StepDispatchInfo）、run 级状态（黑名单等）。只加列，旧行取默认 '{}'。
  if (!stepColumns.has("dispatch_info_json")) db.exec("ALTER TABLE ai_team_steps ADD COLUMN dispatch_info_json TEXT NOT NULL DEFAULT '{}'");
  if (!runColumns.has("run_state_json")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN run_state_json TEXT NOT NULL DEFAULT '{}'");

  // 内置员工标记（如 "wand-ops"）：只加列，用户员工保持 NULL。
  const employeeColumns = new Set((db.prepare("PRAGMA table_info(silicon_employees)").all() as Array<{ name: string }>).map((column) => column.name));
  if (employeeColumns.size > 0 && !employeeColumns.has("system_key")) {
    db.exec("ALTER TABLE silicon_employees ADD COLUMN system_key TEXT");
  }
  if (employeeColumns.size > 0 && !employeeColumns.has("tags_json")) {
    db.exec("ALTER TABLE silicon_employees ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function ensureWandTaskSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(wand_tasks)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (columns.length > 0 && !names.has("identifier")) db.exec("ALTER TABLE wand_tasks ADD COLUMN identifier TEXT");
  if (columns.length > 0 && !names.has("due_date")) db.exec("ALTER TABLE wand_tasks ADD COLUMN due_date TEXT");
  // 任务的默认派发配置（CLI 工具 / 模型 / 思考深度）。只加列，历史行保持 NULL。
  if (columns.length > 0 && !names.has("agent_json")) db.exec("ALTER TABLE wand_tasks ADD COLUMN agent_json TEXT");
  if (columns.length > 0 && !names.has("execution_subject_json")) db.exec("ALTER TABLE wand_tasks ADD COLUMN execution_subject_json TEXT");
  if (columns.length > 0 && !names.has("workspace_task_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN workspace_task_id TEXT");
  // 父任务归属只加列；历史任务仍然是顶层任务。
  if (columns.length > 0 && !names.has("parent_task_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN parent_task_id TEXT");
  // 标题来源：'user' = 用户手写，'auto' = 由描述/会话内容自动生成。只加列，历史行保持 NULL（读取时视为 user）。
  if (columns.length > 0 && !names.has("title_source")) db.exec("ALTER TABLE wand_tasks ADD COLUMN title_source TEXT");
  // 自动标题最近一次的输入指纹：内容没变就不再重复总结（也避免自动标题来回震荡）。只加列。
  if (columns.length > 0 && !names.has("auto_title_signature")) db.exec("ALTER TABLE wand_tasks ADD COLUMN auto_title_signature TEXT");
  // 里程碑：只加列，历史行保持 NULL；里程碑本体在 wand_milestones（INIT_SQL 建表）。
  if (columns.length > 0 && !names.has("milestone_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN milestone_id TEXT");
  // 归档时间（自动/手动归档都写它）：任务自动删除按它起算；历史归档行保持 NULL。
  if (columns.length > 0 && !names.has("archived_at")) db.exec("ALTER TABLE wand_tasks ADD COLUMN archived_at TEXT");
  if (columns.length > 0) {
    // Index creation must wait until the column exists on legacy databases.
    // INIT_SQL cannot create it: CREATE TABLE IF NOT EXISTS is a no-op on old
    // wand_tasks, and CREATE INDEX would then fail with "no such column".
    db.exec("CREATE INDEX IF NOT EXISTS idx_wand_tasks_workspace_task ON wand_tasks(workspace_task_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_wand_tasks_parent ON wand_tasks(parent_task_id)");
    const rows = db.prepare("SELECT id FROM wand_tasks WHERE identifier IS NULL OR identifier = '' ORDER BY created_at, id").all() as Array<{ id: string }>;
    const update = db.prepare("UPDATE wand_tasks SET identifier = ? WHERE id = ?");
    rows.forEach((row, index) => update.run(`TASK-${index + 1}`, row.id));
  }
}

function ensureWorkspaceSchema(db: DatabaseSync): void {
  const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  const workspaceNames = new Set(workspaceColumns.map((column) => column.name));
  if (workspaceColumns.length > 0 && !workspaceNames.has("kind")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'");
  }
  const taskColumns = db.prepare("PRAGMA table_info(workspace_tasks)").all() as Array<{ name: string }>;
  const taskNames = new Set(taskColumns.map((column) => column.name));
  if (taskColumns.length > 0 && !taskNames.has("cwd")) {
    db.exec("ALTER TABLE workspace_tasks ADD COLUMN cwd TEXT");
  }
  if (taskColumns.length > 0 && !taskNames.has("layout_revision")) {
    db.exec("ALTER TABLE workspace_tasks ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 0");
  }
  // 侧栏任务也记里程碑：建任务时把它带到看板卡片上，命名任务与未命名任务保持一致。
  if (taskColumns.length > 0 && !taskNames.has("milestone_id")) {
    db.exec("ALTER TABLE workspace_tasks ADD COLUMN milestone_id TEXT");
  }
}

function ensureWandMilestoneSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(wand_milestones)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  // 里程碑归属工作区：只加列，历史行保持 NULL（读作全局里程碑，所有工作区可见）。
  if (columns.length > 0 && !names.has("workspace_id")) {
    db.exec("ALTER TABLE wand_milestones ADD COLUMN workspace_id TEXT");
  }
  // 默认迭代标记：只加列，历史行保持 0（读作普通迭代）。
  if (columns.length > 0 && !names.has("is_default")) {
    db.exec("ALTER TABLE wand_milestones ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
  }
  if (columns.length > 0) {
    // 索引必须等列存在后再建：老库的 CREATE TABLE IF NOT EXISTS 是空操作，
    // 直接在 INIT_SQL 里建索引会因缺列报错。
    db.exec("CREATE INDEX IF NOT EXISTS idx_wand_milestones_workspace ON wand_milestones(workspace_id, created_at DESC)");
  }
}


function ensureConnectorSchema(db: DatabaseSync): void {
  // The table is created by INIT_SQL for new databases; this repairs an
  // existing wand.db that predates the connector feature (additive-only).
  const columns = db.prepare("PRAGMA table_info(connectors)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.size === 0) return;
  const migrations: ReadonlyArray<[column: string, sql: string]> = [
    ["api_url", "ALTER TABLE connectors ADD COLUMN api_url TEXT NOT NULL DEFAULT ''"],
    ["username", "ALTER TABLE connectors ADD COLUMN username TEXT"],
    ["connected_at", "ALTER TABLE connectors ADD COLUMN connected_at TEXT"],
  ];
  for (const [column, sql] of migrations) {
    if (!names.has(column)) db.exec(sql);
  }
}

const SCHEMA_MIGRATIONS: ReadonlyArray<[column: string, sql: string]> = [
  ["session_source", "ALTER TABLE command_sessions ADD COLUMN session_source TEXT NOT NULL DEFAULT 'interactive'"],
  ["automation_id", "ALTER TABLE command_sessions ADD COLUMN automation_id TEXT"],
  ["archived", "ALTER TABLE command_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"],
  ["archived_at", "ALTER TABLE command_sessions ADD COLUMN archived_at TEXT"],
  ["claude_session_id", "ALTER TABLE command_sessions ADD COLUMN claude_session_id TEXT"],
  ["provider", "ALTER TABLE command_sessions ADD COLUMN provider TEXT"],
  ["session_kind", "ALTER TABLE command_sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'pty'"],
  ["runner", "ALTER TABLE command_sessions ADD COLUMN runner TEXT"],
  ["messages", "ALTER TABLE command_sessions ADD COLUMN messages TEXT"],
  ["queued_messages", "ALTER TABLE command_sessions ADD COLUMN queued_messages TEXT"],
  ["queued_message_skills", "ALTER TABLE command_sessions ADD COLUMN queued_message_skills TEXT"],
  ["structured_state", "ALTER TABLE command_sessions ADD COLUMN structured_state TEXT"],
  ["resumed_from_session_id", "ALTER TABLE command_sessions ADD COLUMN resumed_from_session_id TEXT"],
  // Legacy column: never written by current persist helpers. Kept because
  // schema migrations are additive-only and must not DROP columns.
  ["resumed_to_session_id", "ALTER TABLE command_sessions ADD COLUMN resumed_to_session_id TEXT"],
  ["auto_recovered", "ALTER TABLE command_sessions ADD COLUMN auto_recovered INTEGER NOT NULL DEFAULT 0"],
  ["worktree_enabled", "ALTER TABLE command_sessions ADD COLUMN worktree_enabled INTEGER NOT NULL DEFAULT 0"],
  ["worktree_info", "ALTER TABLE command_sessions ADD COLUMN worktree_info TEXT"],
  ["worktree_merge_status", "ALTER TABLE command_sessions ADD COLUMN worktree_merge_status TEXT"],
  ["worktree_merge_info", "ALTER TABLE command_sessions ADD COLUMN worktree_merge_info TEXT"],
  ["title", "ALTER TABLE command_sessions ADD COLUMN title TEXT"],
  ["description", "ALTER TABLE command_sessions ADD COLUMN description TEXT"],
  ["pty_output_seq", "ALTER TABLE command_sessions ADD COLUMN pty_output_seq INTEGER NOT NULL DEFAULT 0"],
  ["session_options", `ALTER TABLE command_sessions ADD COLUMN session_options TEXT NOT NULL DEFAULT '{"schemaVersion":1}'`],
  ["workspace_id", "ALTER TABLE command_sessions ADD COLUMN workspace_id TEXT"],
  ["workspace_task_id", "ALTER TABLE command_sessions ADD COLUMN workspace_task_id TEXT"],
  ["completion_revision", "ALTER TABLE command_sessions ADD COLUMN completion_revision INTEGER NOT NULL DEFAULT 0"],
  ["viewed_completion_revision", "ALTER TABLE command_sessions ADD COLUMN viewed_completion_revision INTEGER NOT NULL DEFAULT 0"],
];

const AUTH_SESSION_MIGRATIONS: ReadonlyArray<[column: string, sql: string]> = [
  ["kind", "ALTER TABLE auth_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser-admin'"],
  ["scopes", `ALTER TABLE auth_sessions ADD COLUMN scopes TEXT NOT NULL DEFAULT '["admin"]'`],
];

function ensureAuthSessionSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(auth_sessions)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const [column, sql] of AUTH_SESSION_MIGRATIONS) {
    if (!names.has(column)) db.exec(sql);
  }
}

function ensureCommandSessionSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(command_sessions)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const [column, sql] of SCHEMA_MIGRATIONS) {
    if (!names.has(column)) {
      db.exec(sql);
    }
  }
  if (columns.length > 0) {
    // 侧栏 / 任务面板按 workspace_task_id 反复拉会话：没有索引时每次都是
    // 46MB 表全扫（单次 ~500ms），而 command_sessions 里有 10MB+ 的 output/
    // messages 溢出行。索引只加不删，老库首次启动时建一次。
    db.exec("CREATE INDEX IF NOT EXISTS idx_command_sessions_workspace_task ON command_sessions(workspace_task_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_command_sessions_workspace ON command_sessions(workspace_id)");
  }
}


function applyBaselineSchema(db: DatabaseSync): void {
    db.exec(INIT_SQL);
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, next_run_at TEXT, revision INTEGER NOT NULL,
        cancelled_at TEXT, task_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, run_json TEXT NOT NULL,
        UNIQUE(task_id, scheduled_at)
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs ON scheduled_task_runs(task_id, scheduled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_session ON scheduled_task_runs(json_extract(run_json, '$.receipt.sessionId'));
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_open ON scheduled_task_runs(json_extract(run_json, '$.executionFinishedAt'), json_extract(run_json, '$.state'));
    `);
    ensureAuthSessionSchema(db);
    ensureCommandSessionSchema(db);
    ensureWorkspaceSchema(db);
    ensureWandTaskSchema(db);
    ensureWandMilestoneSchema(db);
    ensureAiTeamSchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_list_state (
        conversation_id TEXT PRIMARY KEY,
        pinned_at TEXT,
        dissolved_at TEXT, dissolved_by TEXT, deleting INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
        peer_employee_id TEXT, session_id TEXT, instance_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_peer ON conversations(owner, peer_employee_id)
        WHERE kind = 'dm';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_session ON conversations(session_id)
        WHERE session_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS conversation_tasks (
        conversation_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, linked_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_messages ON conversation_messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS conversation_requests (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const conversationListColumns = new Set((db.prepare("PRAGMA table_info(conversation_list_state)").all() as Array<{ name: string }>).map(column => column.name));
    for (const [name, type] of [["dissolved_at", "TEXT"], ["dissolved_by", "TEXT"], ["deleting", "INTEGER NOT NULL DEFAULT 0"]]) {
      if (!conversationListColumns.has(name!)) db.exec(`ALTER TABLE conversation_list_state ADD COLUMN ${name} ${type}`);
    }
    const conversationRunColumns = new Set((db.prepare("PRAGMA table_info(ai_team_runs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!conversationRunColumns.has("conversation_id")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN conversation_id TEXT");
    if (!conversationRunColumns.has("member_version")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN member_version INTEGER");
    if (!conversationRunColumns.has("round_number")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN round_number INTEGER");
    ensureConnectorSchema(db);
  {
    const missionColumns = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
    if (missionColumns.length > 0 && !missionColumns.some((column) => column.name === "task_id")) {
      db.exec("ALTER TABLE missions ADD COLUMN task_id TEXT");
    }
    // 并行任务的里程碑与看板共用同一份列表；只加列，历史行保持 NULL。
    if (missionColumns.length > 0 && !missionColumns.some((column) => column.name === "milestone_id")) {
      db.exec("ALTER TABLE missions ADD COLUMN milestone_id TEXT");
    }
  }
}

/**
 * Versioned schema. `PRAGMA user_version` is the single source of truth:
 * version 1 is the baseline (INIT_SQL + the idempotent legacy ensure steps, which
 * only ever add tables, columns and indexes), later versions are frozen
 * migrations in storage/migrations.ts. Migrations never drop data.
 */
const BASELINE_MIGRATION: StorageMigration = {
  version: 1,
  name: "baseline",
  up: (db) => applyBaselineSchema(db),
};

const ALL_MIGRATIONS: readonly StorageMigration[] = [BASELINE_MIGRATION, ...STORAGE_MIGRATIONS];

/** Highest schema version this binary knows. A database above it is newer than the binary. */
export const STORAGE_SCHEMA_VERSION = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]!.version;

export class NewerStorageSchemaError extends Error {
  readonly databaseVersion: number;
  readonly supportedVersion: number;

  constructor(databaseVersion: number, supportedVersion: number) {
    super(`[wand] database schema v${databaseVersion} is newer than this build (v${supportedVersion}); refusing to open it`);
    this.name = "NewerStorageSchemaError";
    this.databaseVersion = databaseVersion;
    this.supportedVersion = supportedVersion;
  }
}

export function readStorageSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function hasUserTables(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { count: number };
  return row.count > 0;
}

/** Consistent (WAL-safe) copy of the database before a schema upgrade, readable only by the owner. */
function backupBeforeMigration(db: DatabaseSync, dbPath: string, fromVersion: number): string {
  const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const target = `${dbPath}.pre-v${fromVersion}-${suffix}.bak`;
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  chmodSync(target, 0o600);
  return target;
}

export interface StorageMigrationReport {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly backupPath: string | null;
  /** True when the database was written by a newer binary: migrations are skipped, data is untouched. */
  readonly newerSchema: boolean;
}

/**
 * Apply pending migrations in order. Each runs in its own BEGIN IMMEDIATE
 * transaction and re-reads user_version under the write lock, so a CLI and a
 * server opening the same file cannot both apply one step.
 *
 * A database newer than this binary is refused before any schema-dependent
 * initialization or mutation; older code must not seed/re-encrypt against an
 * unknown schema.
 */
export function migrateStorageSchema(db: DatabaseSync, options: { dbPath: string; context?: StorageMigrationContext }): StorageMigrationReport {
  const fromVersion = readStorageSchemaVersion(db);
  if (fromVersion > STORAGE_SCHEMA_VERSION) {
    throw new NewerStorageSchemaError(fromVersion, STORAGE_SCHEMA_VERSION);
  }
  const pending = ALL_MIGRATIONS.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) return { fromVersion, toVersion: fromVersion, backupPath: null, newerSchema: false };

  const context = options.context ?? { dataDir: path.dirname(options.dbPath) };
  // A brand-new file has nothing to lose, so it needs no pre-migration copy.
  const backupPath = hasUserTables(db) ? backupBeforeMigration(db, options.dbPath, fromVersion) : null;
  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (readStorageSchemaVersion(db) < migration.version) {
        migration.up(db, context);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw new Error(`[wand] storage migration v${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return { fromVersion, toVersion: readStorageSchemaVersion(db), backupPath, newerSchema: false };
}

/** Open (creating if needed) and migrate a database file. Owner-only permissions. */
export function openStorageDatabase(dbPath: string): DatabaseSync {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    // Refuse an unsupported database before chmod, migrations, or facade setup can
    // alter its file, schema, or contents. PRAGMA reads do not write the database.
    db.exec("PRAGMA busy_timeout = 5000");
    const version = readStorageSchemaVersion(db);
    if (version > STORAGE_SCHEMA_VERSION) throw new NewerStorageSchemaError(version, STORAGE_SCHEMA_VERSION);

    chmodSync(dir, 0o700);
    // Migrations take the write lock; without this a concurrent CLI/Server writer
    // aborts startup with SQLITE_BUSY instead of waiting its turn.
    chmodSync(dbPath, 0o600);
    migrateStorageSchema(db, { dbPath });
    chmodSync(dbPath, 0o600);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function ensureDatabaseFile(dbPath: string): boolean {
  const created = !existsSync(dbPath);
  openStorageDatabase(dbPath).close();
  return created;
}

