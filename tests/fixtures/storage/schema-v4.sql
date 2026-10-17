-- Historical schema from Wand commit 3bfbf35 (before employee IM), schema v4.
-- Exported from openStorageDatabase(); schema and its required empty singleton, no user data.

CREATE TABLE auth_sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'browser-admin',
    scopes TEXT NOT NULL DEFAULT '["admin"]'
  );

CREATE TABLE command_sessions (
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
  , workspace_id TEXT, workspace_task_id TEXT, completion_revision INTEGER NOT NULL DEFAULT 0, viewed_completion_revision INTEGER NOT NULL DEFAULT 0);

CREATE TABLE app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

CREATE TABLE session_directory_names (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE TABLE password_vaults (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE TABLE connectors (
    provider TEXT PRIMARY KEY,
    token TEXT NOT NULL DEFAULT '',
    api_url TEXT NOT NULL DEFAULT '',
    username TEXT,
    connected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE TABLE password_items (
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

CREATE TABLE missions (
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

CREATE TABLE mission_attempts (
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

CREATE TABLE mission_review_comments (
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

CREATE TABLE agent_activity (
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

CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'project',
    default_provider TEXT,
    layout_json TEXT,
    created_at TEXT NOT NULL,
    last_opened_at TEXT
  );

CREATE TABLE workspace_tasks (
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

CREATE TABLE github_issue_bindings (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    PRIMARY KEY (owner, repo, issue_number, session_id),
    FOREIGN KEY (session_id) REFERENCES command_sessions(id) ON DELETE CASCADE
  );

CREATE TABLE wand_milestones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    due_date TEXT,
    workspace_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE TABLE wand_iteration_prompts (
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

CREATE TABLE wand_tasks (
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

CREATE TABLE wand_task_sessions (
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    PRIMARY KEY (task_id, session_id),
    FOREIGN KEY (task_id) REFERENCES wand_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES command_sessions(id) ON DELETE CASCADE
  );

CREATE TABLE ai_teams (
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

CREATE TABLE silicon_employees (
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
  , tags_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE employee_knowledge (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES silicon_employees(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (employee_id, content_hash)
  );

CREATE TABLE employee_knowledge_access (
    token_hash TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES silicon_employees(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

CREATE TABLE decision_access (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

CREATE TABLE openrouter_free_access (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    selector TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

CREATE TABLE user_memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    dedup_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE user_memory_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    source_id INTEGER NOT NULL DEFAULT 0,
    profile_json TEXT
  );

CREATE TABLE ai_team_runs (
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
  , chat_session_id TEXT, pending_notes_json TEXT NOT NULL DEFAULT '[]', run_state_json TEXT NOT NULL DEFAULT '{}', conversation_id TEXT, member_version INTEGER, round_number INTEGER);

CREATE TABLE ai_team_steps (
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
    ended_at TEXT, dispatch_info_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (run_id, seq)
  );

CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, next_run_at TEXT, revision INTEGER NOT NULL,
        cancelled_at TEXT, task_json TEXT NOT NULL
      );

CREATE TABLE scheduled_task_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, run_json TEXT NOT NULL,
        UNIQUE(task_id, scheduled_at)
      );

CREATE TABLE conversation_list_state (
        conversation_id TEXT PRIMARY KEY,
        pinned_at TEXT,
        dissolved_at TEXT, dissolved_by TEXT, deleting INTEGER NOT NULL DEFAULT 0
      );

CREATE TABLE conversations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
        peer_employee_id TEXT, session_id TEXT, instance_json TEXT NOT NULL
      );

CREATE TABLE conversation_tasks (
        conversation_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, linked_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, task_id)
      );

CREATE TABLE conversation_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_json TEXT NOT NULL, created_at TEXT NOT NULL
      );

CREATE TABLE conversation_requests (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );

CREATE INDEX idx_password_items_vault ON password_items(vault_id);

CREATE INDEX idx_password_items_type ON password_items(type);

CREATE INDEX idx_password_items_updated ON password_items(updated_at);

CREATE INDEX idx_missions_updated ON missions(updated_at);

CREATE INDEX idx_mission_attempts_mission ON mission_attempts(mission_id);

CREATE UNIQUE INDEX idx_mission_attempts_session ON mission_attempts(session_id) WHERE session_id IS NOT NULL;

CREATE INDEX idx_mission_comments_attempt ON mission_review_comments(attempt_id, status);

CREATE INDEX idx_agent_activity_state ON agent_activity(state, updated_at);

CREATE INDEX idx_workspaces_cwd ON workspaces(cwd);

CREATE INDEX idx_workspaces_last_opened ON workspaces(last_opened_at);

CREATE INDEX idx_workspace_tasks_workspace ON workspace_tasks(workspace_id);

CREATE INDEX idx_workspace_tasks_last_opened ON workspace_tasks(last_opened_at);

CREATE INDEX idx_github_issue_bindings_session ON github_issue_bindings(session_id);

CREATE INDEX idx_wand_milestones_created ON wand_milestones(created_at DESC);

CREATE INDEX idx_wand_iteration_prompts_iteration ON wand_iteration_prompts(milestone_id, created_at DESC);

CREATE INDEX idx_wand_iteration_prompts_repo ON wand_iteration_prompts(repo_key, created_at DESC);

CREATE INDEX idx_wand_iteration_prompts_session ON wand_iteration_prompts(session_id, created_at DESC);

CREATE INDEX idx_wand_tasks_board ON wand_tasks(workspace_id, status, sort_order, updated_at);

CREATE INDEX idx_wand_task_sessions_session ON wand_task_sessions(session_id);

CREATE INDEX idx_silicon_employees_archived ON silicon_employees(archived_at);

CREATE INDEX idx_employee_knowledge_owner ON employee_knowledge(employee_id, created_at);

CREATE INDEX idx_employee_knowledge_access_expiry ON employee_knowledge_access(expires_at);

CREATE INDEX idx_decision_access_expiry ON decision_access(expires_at);

CREATE INDEX idx_openrouter_free_access_expiry ON openrouter_free_access(expires_at);

CREATE INDEX idx_user_memory_events_created ON user_memory_events(created_at);

CREATE INDEX idx_user_memory_events_dedup ON user_memory_events(dedup_key, created_at);

CREATE INDEX idx_ai_team_runs_task ON ai_team_runs(task_id, created_at);

CREATE INDEX idx_ai_team_runs_status ON ai_team_runs(status);

CREATE INDEX idx_ai_team_steps_session ON ai_team_steps(session_id, status);

CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);

CREATE INDEX idx_scheduled_task_runs ON scheduled_task_runs(task_id, scheduled_at DESC);

CREATE INDEX idx_scheduled_task_runs_session ON scheduled_task_runs(json_extract(run_json, '$.receipt.sessionId'));

CREATE INDEX idx_scheduled_task_runs_open ON scheduled_task_runs(json_extract(run_json, '$.executionFinishedAt'), json_extract(run_json, '$.state'));

CREATE INDEX idx_command_sessions_workspace_task ON command_sessions(workspace_task_id);

CREATE INDEX idx_command_sessions_workspace ON command_sessions(workspace_id);

CREATE INDEX idx_wand_tasks_workspace_task ON wand_tasks(workspace_task_id);

CREATE INDEX idx_wand_tasks_parent ON wand_tasks(parent_task_id);

CREATE INDEX idx_wand_milestones_workspace ON wand_milestones(workspace_id, created_at DESC);

CREATE UNIQUE INDEX idx_conversation_peer ON conversations(owner, peer_employee_id)
        WHERE kind = 'dm';

CREATE UNIQUE INDEX idx_conversation_session ON conversations(session_id)
        WHERE session_id IS NOT NULL;

CREATE INDEX idx_conversation_messages ON conversation_messages(conversation_id, created_at);

CREATE UNIQUE INDEX uniq_wand_tasks_one_card_per_container ON wand_tasks(workspace_task_id) WHERE workspace_task_id IS NOT NULL;

-- Baseline v1 also seeds this singleton before marking the schema version.
INSERT OR IGNORE INTO user_memory_state (id) VALUES (1);

PRAGMA user_version = 4;
