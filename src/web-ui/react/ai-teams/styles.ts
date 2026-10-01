// 团队页与任务运行面板的样式，只打进按需加载的 ai-teams 脚本（见 ai-teams/chunk-entry.ts）。
// 头像、指派面板里的团队预览、侧栏角标主包也用，仍在 styles/features.ts 的 aiTeamsStyles。
export const aiTeamsChunkStyles = String.raw`
/* ---------- 团队页：左列表、右详情 ---------- */
.wand-teams-layout {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
  border-top: 1px solid var(--border-subtle);
}
.wand-teams-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 14px 14px 18px 28px;
  overflow-y: auto;
  border-right: 1px solid var(--border-subtle);
}
.wand-teams-cards { display: grid; gap: 6px; }
.wand-teams-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas: "avatars avatars" "copy copy" "meta meta";
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  background: var(--bg-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.wand-teams-card:hover { border-color: var(--border-default); }
.wand-teams-card[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 55%, var(--border-subtle)); background: var(--accent-muted); }
.wand-teams-card > .wand-team-avatar-stack { grid-area: avatars; }
.wand-teams-card-copy { grid-area: copy; display: grid; gap: 2px; min-width: 0; }
.wand-teams-card-copy strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.wand-teams-card-copy small,
.wand-teams-card-meta small { overflow: hidden; color: var(--text-tertiary); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.wand-teams-card-meta { grid-area: meta; display: flex; min-width: 0; }
.wand-teams-empty { display: grid; justify-items: center; gap: 10px; padding: 28px 12px; color: var(--text-tertiary); font-size: var(--font-size-sm); text-align: center; }
.wand-teams-empty p { margin: 0; }
.wand-teams-empty.is-detail { align-content: center; height: 100%; }

.wand-teams-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  min-height: 0;
  padding: 18px 28px 32px;
  overflow-y: auto;
  animation: wand-settings-fade-in var(--transition-normal);
}
.wand-teams-detail > * { flex: 0 0 auto; width: 100%; max-width: 920px; }
/* 团队详情两个面板叠放常驻，切标签只翻可见性：进场 normal、旧内容退场 quick-exit（§5.3）。 */
.wand-teams-detail-stack { position: relative; display: grid; }
.wand-teams-detail-pane {
  grid-area: 1 / 1;
  min-width: 0;
  opacity: 1;
  transition: opacity var(--motion-normal) var(--ease-in-out-smooth);
}
.wand-teams-detail-pane[data-hidden] {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity var(--motion-quick-exit) var(--ease-in-out-smooth), visibility var(--motion-quick-exit) step-end;
}
.wand-teams-detail > .wand-stretch-tabs { width: auto; align-self: flex-start; }
.wand-teams-detail-head { display: flex; align-items: center; gap: 14px; min-width: 0; }
.wand-teams-detail-head h2 { margin: 0; font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); }
.wand-teams-detail-head p { margin: 2px 0 0; color: var(--text-tertiary); font-size: var(--font-size-sm); }
.wand-teams-create-icon { transition: transform var(--transition-normal); }
.task-board-create-button[aria-pressed="true"] .wand-teams-create-icon { transform: rotate(45deg); }

.wand-teams-templates { display: grid; gap: 12px; }
.wand-teams-template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
.wand-teams-template {
  display: grid;
  justify-items: start;
  gap: 6px;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  background: var(--bg-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--transition-fast), transform var(--transition-fast);
}
.wand-teams-template:hover { border-color: var(--accent); }
.wand-teams-template:active { transform: scale(0.98); }
.wand-teams-template strong { font-size: var(--font-size-sm); }
.wand-teams-template small { color: var(--text-tertiary); font-size: var(--font-size-xs); }

/* ---------- 团队编辑：成员组织图 + 协作设置 ---------- */
.wand-team-editor { display: grid; gap: 22px; }
.wand-team-section { display: grid; gap: 12px; }
.wand-team-section-head { display: flex; align-items: baseline; gap: 10px; }
.wand-team-section-head h3 { margin: 0; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.wand-team-section-head small { color: var(--text-tertiary); font-size: var(--font-size-xs); }
.wand-team-org { display: grid; gap: 22px; }
.wand-team-org-leader { position: relative; display: grid; justify-items: center; }
.wand-team-org-leader > .wand-team-member { width: min(100%, 420px); }
.wand-team-org-leader::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  width: 1px;
  height: 22px;
  background: var(--border-default);
}
.wand-team-org-members {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  align-items: start;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border-default);
}
.wand-team-member {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  transition: border-color var(--transition-fast);
}
.wand-team-member[data-leader] { border-color: color-mix(in srgb, var(--warning) 45%, var(--border-subtle)); }
.wand-team-member[data-open] { grid-column: 1 / -1; border-color: var(--border-default); }
.wand-team-member-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 12px 12px;
  border: 0;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wand-team-member-copy { display: grid; gap: 2px; min-width: 0; }
.wand-team-member-copy strong { display: flex; align-items: center; gap: 6px; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.wand-team-member-copy em {
  padding: 0 6px;
  border-radius: var(--radius-full);
  color: var(--warning);
  background: var(--warning-muted);
  font-size: 11px;
  font-style: normal;
  font-weight: var(--font-weight-medium);
}
.wand-team-member-copy small {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.wand-team-member-agent { overflow: hidden; color: var(--text-tertiary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.wand-team-member-inner { display: grid; gap: 10px; padding: 0 12px; }
.wand-team-member[data-open] .wand-team-member-inner { padding-bottom: 12px; }
.wand-team-member-actions { display: flex; justify-content: flex-end; gap: 6px; }
.wand-team-member-add {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 4px;
  min-height: 76px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.wand-team-member-add:hover:not(:disabled) { color: var(--text-primary); border-color: var(--border-strong); }
.wand-team-member-add:disabled { opacity: 0.5; cursor: not-allowed; }
.wand-team-avatar-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.wand-team-coat {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: 30%;
  color: var(--text-tertiary);
  background: var(--bg-tertiary);
  cursor: pointer;
}
.wand-team-coat svg { width: 72%; height: 72%; }
.wand-team-coat[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-muted); }
.wand-team-avatar-error { color: var(--danger); font-size: var(--font-size-xs); }
.wand-team-empty-line { margin: 0; color: var(--text-tertiary); font-size: var(--font-size-sm); }

.wand-ai-team-editor-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; }
.wand-ai-team-duty { min-height: 58px; resize: none; }
.wand-ai-team-member-agent { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.wand-ai-team-editor-footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.wand-ai-team-editor-footer .wand-settings-save-bar { flex: 1 1 auto; }

/* ---------- 成员执行候选：一行一个候选，顺序即降级顺序 ---------- */
.wand-team-candidates {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}
.wand-team-candidates-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.wand-team-candidates-head > span { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.wand-team-candidates-head > small { color: var(--text-tertiary); font-size: var(--font-size-xs); }
.wand-team-candidates-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }

/* 新行原位长高（0fr → 1fr）并淡入，删除把同一段过渡倒放。
   这里刻意不给它写 transition: none —— 收起的提交靠 transitionend，
   styles.css 的全局 reduce-motion 规则会把时长压到近零：瞬时，但事件仍在。 */
.wand-team-candidate-slot {
  display: grid;
  grid-template-rows: 1fr;
  opacity: 1;
  transition: grid-template-rows var(--motion-normal) var(--ease-in-out-smooth),
              opacity var(--motion-fast) var(--ease-in-out-smooth);
}
.wand-team-candidate-slot[data-collapsed] { grid-template-rows: 0fr; opacity: 0; }
.wand-team-candidate {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
}
.wand-team-candidate-tag {
  padding: 3px 8px;
  border-radius: var(--radius-full);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-size: 11px;
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}
.wand-team-candidate-slot:first-of-type .wand-team-candidate-tag { color: var(--accent); background: var(--accent-muted); }
.wand-team-candidate[data-duplicate] .wand-team-candidate-tag { color: var(--danger); background: var(--danger-muted); }
.wand-team-candidate-tools { display: flex; gap: 2px; }
.wand-team-candidate-tool {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
  background: transparent;
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-in-out-smooth),
              background var(--motion-fast) var(--ease-in-out-smooth),
              opacity var(--motion-fast) var(--ease-in-out-smooth),
              transform var(--motion-press) var(--ease-out-expo);
}
.wand-team-candidate-tool > svg { transition: transform var(--motion-morph) var(--ease-out-back); }
.wand-team-candidate-tool:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
.wand-team-candidate-tool:active:not(:disabled) { transform: scale(0.9); }
/* 箭头按方向位移、删除图标转半圈：形态衔接不硬切。 */
.wand-team-candidate-tool[data-tool="up"]:hover:not(:disabled) > svg { transform: translateY(-2px); }
.wand-team-candidate-tool[data-tool="down"]:hover:not(:disabled) > svg { transform: translateY(2px); }
.wand-team-candidate-tool[data-tool="remove"]:hover:not(:disabled) > svg { transform: rotate(-90deg); }
.wand-team-candidate-add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-full);
  color: var(--text-tertiary);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-in-out-smooth),
              border-color var(--motion-fast) var(--ease-in-out-smooth),
              opacity var(--motion-fast) var(--ease-in-out-smooth),
              transform var(--motion-press) var(--ease-out-expo);
}
.wand-team-candidate-add > svg { transition: transform var(--motion-morph) var(--ease-out-back); }
.wand-team-candidate-add:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent); }
/* ＋ 用 morph 曲线长大一档再按下去，和行尾 ✕ 转半圈是同一对形变语言。 */
.wand-team-candidate-add:hover:not(:disabled) > svg { transform: scale(1.15); }
.wand-team-candidate-add:active:not(:disabled) { transform: scale(0.96); }
/* 禁用态一律降透明度，不换色、不变形。 */
.wand-team-candidate-tool:disabled,
.wand-team-candidate-add:disabled { opacity: 0.4; cursor: not-allowed; }
.wand-team-candidate-error { color: var(--danger); font-size: var(--font-size-xs); }

/* ---------- 新建员工：默认只填期望，手动字段收进高级配置 ---------- */
/* 创建 / 生成中标签长度不同，固定最小宽度保证提交按钮原地不位移。 */
.wand-employee-create-submit { min-inline-size: 92px; }
.wand-employee-hint { margin: 0; color: var(--text-tertiary); font-size: var(--font-size-xs); }
.wand-employee-advanced-toggle { display: flex; justify-content: flex-start; }
.wand-employee-advanced-toggle button > svg:last-child { transition: transform var(--transition-fast); }
.wand-employee-advanced-toggle[data-open] button > svg:last-child { transform: rotate(180deg); }
.wand-employee-advanced {
  display: grid;
  grid-template-rows: 0fr;
  /* 作为父网格的项目不能跟着行高拉伸，否则收起后仍占一段 gap 的高度。 */
  align-self: start;
  /* 抵消 .wand-team-member-inner 的 10px gap：收起时不能多留一段空白。 */
  margin-block-start: -10px;
  opacity: 0;
  transition: grid-template-rows var(--transition-normal),
              margin-block-start var(--transition-normal),
              opacity var(--transition-fast);
}
.wand-employee-advanced[data-open] { grid-template-rows: 1fr; margin-block-start: 0; opacity: 1; }
.wand-employee-advanced-inner { display: grid; gap: 10px; min-height: 0; overflow: hidden; }
.wand-employee-advanced-tools { display: flex; justify-content: flex-end; }

/* ---------- 运行记录 ---------- */
.wand-team-runs { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.wand-team-run { border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-secondary); }
.wand-team-run-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wand-team-run-head strong { overflow: hidden; font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.wand-team-run-id { color: var(--text-tertiary); font-family: var(--font-mono); font-size: var(--font-size-xs); }
.wand-team-run-head small { color: var(--text-tertiary); font-size: var(--font-size-xs); }
.wand-team-run-inner { min-height: 0; overflow: hidden; }
.wand-team-run[data-open] .wand-team-run-inner { padding: 0 10px 10px; }
.wand-team-run-inner > .task-board-team-run { border: 0; padding: 4px 2px; background: transparent; }

/* ---------- 任务详情里的团队运行 ---------- */
.task-board-team { display: grid; gap: 10px; margin-top: 14px; }
.task-board-team-run {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}
.task-board-team-run-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* 区块标题行：只比正文高一档，不与页面头部争同层标题。 */
.task-board-team-run-kicker { color: var(--text-tertiary); font-size: var(--font-size-xs); font-weight: var(--font-weight-medium); letter-spacing: 0.04em; }
.task-board-team-run-head strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.task-board-team-run-head small { margin-right: auto; color: var(--text-tertiary); font-size: var(--font-size-xs); }
.task-board-team-run-detail { margin: 0; color: var(--text-secondary); font-size: var(--font-size-xs); }
.task-board-team-error { margin: 0; color: var(--danger); font-size: var(--font-size-xs); }
.task-board-team-roster { display: flex; gap: 6px; overflow-x: auto; padding: 6px 2px 2px; }
.task-board-team-roster-item {
  display: grid;
  justify-items: center;
  gap: 4px;
  min-width: 64px;
  padding: 8px 6px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.task-board-team-roster-item:hover { background: var(--bg-hover); }
.task-board-team-roster-item[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-muted); }
.task-board-team-roster-item > span:not(.wand-team-avatar) { max-width: 72px; overflow: hidden; font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.task-board-team-roster-item small { color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.task-board-team-banner { display: grid; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.task-board-team-banner[data-attention] { background: var(--warning-muted); box-shadow: inset 3px 0 0 var(--warning); }
.task-board-team-banner p { margin: 0; color: var(--text-secondary); font-size: var(--font-size-xs); white-space: pre-wrap; }

.task-board-team-views { justify-self: start; }
.task-board-team-groups { display: grid; gap: 14px; }

/* ---------- 三视图叠放与内嵌群聊 ---------- */
/* 视图容器常驻，切换只翻可见性：进场 normal、退场 quick-exit（§5.3/S6）。 */
.task-board-team-views-stack { position: relative; display: grid; }
.task-board-team-view {
  grid-area: 1 / 1;
  min-width: 0;
  opacity: 1;
  transition: opacity var(--motion-normal) var(--ease-in-out-smooth);
}
.task-board-team-view[data-hidden] {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity var(--motion-quick-exit) var(--ease-in-out-smooth), visibility var(--motion-quick-exit) step-end;
}
.task-board-team-chat { display: grid; gap: 8px; }

/* 群聊首屏只留一行公告摘要；成员与任务都从同一处原位展开。 */
.team-chat-context {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 38px;
  padding: 7px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  background: var(--bg-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.team-chat-context:hover, .team-chat-context:focus-visible { border-color: var(--accent); }
.team-chat-context-label { flex: none; color: var(--accent); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.team-chat-context-title { flex: 1; min-width: 0; overflow: hidden; font-size: var(--font-size-sm); text-overflow: ellipsis; white-space: nowrap; }
.team-chat-context-action { flex: none; color: var(--text-tertiary); font-size: var(--font-size-xs); }
.team-chat-details {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows var(--motion-normal) var(--ease-in-out-smooth), opacity var(--motion-fast) var(--ease-in-out-smooth);
}
.team-chat-details[data-open] { grid-template-rows: 1fr; opacity: 1; }
.team-chat-details-inner { display: grid; gap: 12px; min-height: 0; overflow: hidden; }

/* 「主任务」：钉在群聊最上面的公告位，滚动时不动。 */
.team-chat-goal {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--accent-muted);
}
.team-chat-goal-head { display: flex; align-items: center; gap: 8px; }
.team-chat-goal-label {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  color: var(--accent);
  background: var(--bg-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}
.team-chat-goal-meta { margin-left: auto; color: var(--text-tertiary); font-size: var(--font-size-xs); }
.team-chat-goal-preview {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.team-chat-goal-body-text { margin: 0; color: var(--text-secondary); font: inherit; font-size: var(--font-size-xs); white-space: pre-wrap; overflow-wrap: anywhere; }

/* 群聊的工位总览来自本轮真实步骤；成员有会话时整张卡可进入该工位。 */
.team-chat-office { display: grid; gap: 8px; }
.team-chat-office-head { display: flex; align-items: baseline; gap: 8px; }
.team-chat-office-head strong { font-size: var(--font-size-sm); color: var(--text-primary); }
.team-chat-office-head small { min-width: 0; margin-left: auto; color: var(--text-tertiary); font-size: var(--font-size-xs); text-align: right; }
.team-chat-office-members { display: flex; gap: 8px; overflow-x: auto; padding: 1px 1px 5px; scroll-snap-type: x proximity; }
.team-chat-office-member {
  display: flex;
  flex: 0 0 210px;
  align-items: center;
  gap: 7px;
  min-width: 0;
  min-height: 52px;
  padding: 7px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-primary);
  text-align: left;
  scroll-snap-align: start;
}
button.team-chat-office-member { cursor: pointer; transition: border-color var(--motion-fast) var(--ease-in-out-smooth); }
button.team-chat-office-member:hover, button.team-chat-office-member:focus-visible { border-color: var(--accent); }
.team-chat-office-copy { display: grid; flex: 1; gap: 2px; min-width: 0; }
.team-chat-office-copy strong, .team-chat-office-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.team-chat-office-copy strong { font-size: var(--font-size-xs); }
.team-chat-office-copy small { color: var(--text-tertiary); font-size: var(--font-size-xs); }
.team-chat-office-state { flex: 0 0 auto; color: var(--text-tertiary); font-size: var(--font-size-xs); }
.team-chat-office-state[data-state="working"] { color: var(--info); }
.team-chat-office-state[data-state="attention"] { color: var(--warning); }
.team-chat-office-state[data-state="done"] { color: var(--success); }
.team-chat-office-state[data-state="failed"] { color: var(--danger); }

.task-board-team-chat-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 360px;
  padding: 4px 2px;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}
.task-board-team-chat .team-chat-time-marker {
  align-self: center;
  margin: 6px 0 0;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  line-height: var(--line-height-base);
}
.task-board-team-chat .chat-notice .team-chat-mention {
  display: inline;
  max-width: none;
  padding: 0;
  border-radius: 0;
  color: var(--accent);
  background: transparent;
  font-weight: inherit;
  white-space: inherit;
  overflow: visible;
}

/* ---------- 消息行（IM）：头像 + 署名行 + 气泡 / 全宽文档卡 ---------- */
/* 每条发言都看得出是谁说的：头像与名字在内容列外侧，自己的发言整行镜像靠右。 */
.task-board-team-chat .team-chat-msg {
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  max-width: 100%;
}
/* 普通会话的消息行 hover 会上浮 1px；群聊这一行承载的是头像，一律不位移。 */
.task-board-team-chat .team-chat-msg:hover { transform: none; }
.task-board-team-chat .team-chat-msg[data-side="end"] { flex-direction: row-reverse; }
.task-board-team-chat .team-chat-msg-content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}
.task-board-team-chat .team-chat-msg[data-side="end"] .team-chat-msg-content { align-items: flex-end; }
/* 短发言的气泡不到 560px；文档卡全宽铺开。 */
.task-board-team-chat .team-chat-msg[data-shape="bubble"] .team-chat-msg-content { max-width: min(100%, 560px); }
.task-board-team-chat .team-chat-msg[data-shape="document"] .team-chat-msg-content { max-width: 100%; }
/* 行距统一 12（设计 v2.5-A3）：普通会话的 .chat-message 自带 margin: 4px 0，
   叠上列表 gap: 12px 就是 20px，这里只把消息行自身的外边距清零。 */
.task-board-team-chat .chat-message.team-chat-msg { margin: 0; }
.task-board-team-chat .team-chat-msg-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
/* 署名行名字 12px/600（设计 v2.5-A1）；只覆盖群聊作用域，不动 content/styles.css 的共享 .avatar-name。 */
.task-board-team-chat .team-chat-msg-head .avatar-name {
  max-width: 160px;
  overflow: hidden;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 不可点的名字用正文色（设计 v2.5-A2）：只有 <button class="chat-author-link"> 才是动作色。 */
.task-board-team-chat .team-chat-msg-head span.avatar-name { color: var(--text-primary); }
.task-board-team-chat .team-chat-msg-head .chat-message-time { padding: 0; font-size: var(--font-size-2xs); }
/* @ 流转 token：动作色/软底均取主题真值，原文不改；正文用 CSS 24ch 视觉省略，
   Portal 全文层解除省略以便读/复制完整姓名（R2.4）。 */
.task-board-team-chat .team-chat-mention,
.team-chat-doc-layer .team-chat-mention {
  display: inline-block;
  max-width: min(24ch, 100%);
  overflow: hidden;
  padding: 0 4px;
  border-radius: var(--radius-xs);
  color: var(--accent);
  background: var(--accent-muted);
  font-weight: var(--font-weight-medium);
  text-overflow: ellipsis;
  vertical-align: baseline;
  white-space: nowrap;
}
.team-chat-doc-layer .team-chat-mention {
  max-width: 100%;
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}
/* 头像只在这一处画：消息行 32px、弹层元信息行 24px，两端同一张脸、同一比例。 */
.task-board-team-chat .team-chat-avatar,
.team-chat-doc-layer .team-chat-avatar {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 32px;
  height: 32px;
  overflow: hidden;
  border-radius: 30%;
  background: var(--bg-tertiary);
}
.task-board-team-chat .team-chat-avatar[data-size="sm"],
.team-chat-doc-layer .team-chat-avatar[data-size="sm"] { width: 24px; height: 24px; }
/* 默认 APP logo 自带底色与圆角，不再套第二层。 */
.task-board-team-chat .team-chat-avatar[data-kind="brand"],
.team-chat-doc-layer .team-chat-avatar[data-kind="brand"] { background: transparent; }
.task-board-team-chat .team-chat-avatar .wand-team-avatar-cat,
.team-chat-doc-layer .team-chat-avatar .wand-team-avatar-cat { width: 74%; height: 74%; }
.task-board-team-chat .team-chat-avatar-upload,
.team-chat-doc-layer .team-chat-avatar-upload { display: block; width: 100%; height: 100%; object-fit: cover; }
.task-board-team-chat .team-chat-avatar-brand,
.team-chat-doc-layer .team-chat-avatar-brand { display: block; width: 100%; height: 100%; }
/* 气泡：靠头像的那个上角收紧，其余三角走常规圆角。
   选择器带上 .chat-message 与 .team-chat-msg 是为了压过既有普通会话的
   .chat-message.assistant .chat-message-bubble（内边距 14/18、字号 12.25px），
   群聊复用同一个类名，但不沿用普通会话的量。 */
.task-board-team-chat .chat-message.team-chat-msg .team-chat-bubble {
  display: grid;
  justify-items: start;
  gap: 4px;
  padding: 10px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  color: var(--text-primary);
  background: var(--bg-surface);
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
}
.task-board-team-chat .team-chat-msg[data-side="start"] .team-chat-bubble { border-top-left-radius: 6px; }
.task-board-team-chat .team-chat-msg[data-side="end"] .team-chat-bubble {
  justify-items: end;
  border-color: transparent;
  border-top-right-radius: 6px;
  color: var(--text-inverse);
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
}
.task-board-team-chat .team-chat-bubble-text,
.task-board-team-chat .team-chat-doc-text {
  margin: 0;
  font: inherit;
  font-size: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-board-team-chat .team-chat-attachments,
.team-chat-doc-layer .team-chat-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
}
.task-board-team-chat .team-chat-attachment,
.team-chat-doc-layer .team-chat-attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 34px;
  padding: 6px 9px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  background: var(--bg-elevated);
  font: inherit;
  font-size: var(--font-size-xs);
  text-align: left;
  cursor: pointer;
}
.task-board-team-chat .team-chat-attachment:hover,
.team-chat-doc-layer .team-chat-attachment:hover { border-color: var(--accent); }
.task-board-team-chat .team-chat-attachment:focus-visible,
.team-chat-doc-layer .team-chat-attachment:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.task-board-team-chat .team-chat-attachment span,
.team-chat-doc-layer .team-chat-attachment span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-board-team-chat .team-chat-attachment[data-image],
.team-chat-doc-layer .team-chat-attachment[data-image] { min-height: 0; padding: 0; line-height: 0; }
.task-board-team-chat .team-chat-attachment img,
.team-chat-doc-layer .team-chat-attachment img {
  display: block;
  width: auto;
  max-width: min(220px, 52vw);
  height: auto;
  max-height: 180px;
  object-fit: contain;
}
/* 文件消息只显示文件身份；正文在公共预览中按需读取。 */
.task-board-team-chat .team-chat-file-card {
  width: min(100%, 360px);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}
.task-board-team-chat .team-chat-file-open {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 54px;
  align-items: start;
  gap: 12px;
  width: 100%;
  padding: 14px;
  border: 0;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}
.task-board-team-chat .team-chat-file-open:hover { background: var(--bg-tertiary); }
.task-board-team-chat .team-chat-file-copy { display: grid; gap: 6px; min-width: 0; }
.task-board-team-chat .team-chat-file-copy strong,
.task-board-team-chat .team-chat-file-excerpt {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
}
.task-board-team-chat .team-chat-file-copy strong {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  -webkit-line-clamp: 2;
}
.task-board-team-chat .team-chat-file-excerpt {
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-base);
  white-space: pre-line;
  -webkit-line-clamp: 3;
}
.task-board-team-chat .team-chat-file-icon {
  display: flex;
  flex-direction: column;
  gap: 4px;
  height: 76px;
  padding: 6px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  color: var(--text-tertiary);
  background: var(--bg-primary);
  font-size: 6px;
  line-height: 8px;
  overflow-wrap: anywhere;
}
.task-board-team-chat .team-chat-file-icon svg { flex: 0 0 auto; color: var(--accent); }
.task-board-team-chat .team-chat-file-icon b { max-height: 16px; overflow: hidden; color: var(--text-secondary); }
.task-board-team-chat .team-chat-file-meta {
  display: flex;
  grid-column: 1 / -1;
  gap: 8px;
  min-width: 0;
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
  font-size: var(--font-size-2xs);
}
.task-board-team-chat .team-chat-file-meta > :first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-board-team-chat .team-chat-file-meta > :last-child { flex: 0 0 auto; white-space: nowrap; }
.task-board-team-chat .team-chat-file-open:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* 文档卡：比气泡深一档的纸面，全宽铺开。 */
.task-board-team-chat .team-chat-doc {
  display: grid;
  justify-items: start;
  gap: 6px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  background: var(--bg-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-base);
}
.task-board-team-chat .team-chat-preview {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-board-team-chat .team-chat-doc .team-chat-preview { color: var(--text-secondary); }
.task-board-team-chat .team-chat-msg-empty { color: var(--text-secondary); }
.task-board-team-chat .team-chat-msg[data-side="end"] .team-chat-msg-empty { color: inherit; opacity: 0.78; }
/* 报告/步骤 chip：署名行上的那一枚，弹层元信息行复用同一个类名。 */
.team-chat-step-chip {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-size: var(--font-size-xs);
}
.team-chat-step-chip[data-ok] { color: var(--success); }
.task-board-team-chat .team-chat-msg[data-status="failed"] .team-chat-step-chip { color: var(--danger); }

/* ---------- 正在输出的成员（§4.9 live 卡片）---------- */
/* 两段式进场：署名先出现，卡片随后长出；收起倒放且固定窗口内滚。 */
@keyframes wand-team-live-grow {
  from { opacity: 0; transform: translateX(-10px); }
}
/* reduce-motion 仍派发 animationend 清理退场行，但所有帧都不含横向位移。 */
@keyframes wand-team-live-reduced {
  from { opacity: 0; transform: none; }
  to { opacity: 1; transform: none; }
}
.team-chat-live-row {
  display: grid;
  gap: 5px;
}
.team-chat-live-row[data-leaving] {
  animation: wand-team-live-grow var(--motion-quick-exit) var(--ease-in-out-smooth) reverse forwards;
}
.team-chat-live-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  animation: wand-team-live-grow var(--motion-fast) var(--ease-out-expo) both;
}
/* live 署名行不再放头像（设计 v2.2.4）：只留名字 + 步骤 chip + 状态 chip + 时刻，
   名字用弱化字号（它不承载「一条发言的署名」，是卡片自己的元信息），也不单独挂链接。 */
.team-chat-live-name {
  max-width: 160px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--font-size-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team-chat-live-chip {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-size: var(--font-size-xs);
}
.team-chat-live-state {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  color: var(--info);
  background: color-mix(in srgb, var(--info) 14%, transparent);
  font-size: var(--font-size-xs);
}
.team-chat-live-state[data-state="needs_input"],
.team-chat-live-state[data-state="needs_permission"] { color: var(--warning); background: var(--warning-muted); }
.team-chat-live-state[data-state="failed"] { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
.team-chat-live-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(100%, 560px);
  min-height: 38px;
  padding: 7px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-secondary);
  font: inherit;
  font-size: var(--font-size-xs);
  text-align: left;
  cursor: pointer;
}
.team-chat-live-summary > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.team-chat-live-summary > small { flex: none; color: var(--accent); }
.team-chat-live-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows var(--motion-normal) var(--ease-in-out-smooth), opacity var(--motion-fast) var(--ease-in-out-smooth);
}
.team-chat-live-body[data-open] { grid-template-rows: 1fr; opacity: 1; }
.team-chat-live-body-inner { min-height: 0; overflow: hidden; }
.team-chat-live-card {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: 100%;
  max-width: 560px;
  height: 200px;
  padding: 8px 10px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-in-out-smooth),
              background var(--motion-fast) var(--ease-in-out-smooth);
}
.team-chat-live-card:hover,
.team-chat-live-card:focus-visible { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-subtle)); }
.team-chat-live-omitted { margin: 0 0 4px; color: var(--text-tertiary); font-size: var(--font-size-xs); }
.team-chat-live-text {
  min-height: 0;
  margin: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 主任务层：负责人决策的派工清单渲染成任务条目，不与成员报告混在一起。 */
.team-chat-plan-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.team-chat-plan-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding: 3px 0;
  font-size: var(--font-size-xs);
}
.team-chat-plan-title { color: var(--text-primary); }
/* 派工行的依据/旧等待说明槽（设计 v2.2.3）：弱化色 11px，新旧两种括注共用。 */
.team-chat-plan-basis { color: var(--text-tertiary); font-size: var(--font-size-2xs); }

/* 主任务公告位：收起给行数截断的预览，展开在原位长高（§7 要求 7，收起是展开的倒放）。
   消息正文不用这套：报告可长达数千字，就地展开会把下面的对话整体顶走，走全文弹层。 */
.team-chat-goal-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows var(--transition-normal), opacity var(--transition-fast);
}
.team-chat-goal-body[data-open] { grid-template-rows: 1fr; opacity: 1; }
.team-chat-goal-body-inner { min-height: 0; overflow: hidden; }

/* 「点击展开」：正文块内部底部的一个**单状态**入口（打开覆盖层，不是原位展开），
   所以不带 ⇄ 图标、也没有第二个文案分支；触控高度不小于 28px。 */
.team-chat-expand {
  justify-self: start;
  min-height: 28px;
  padding: 4px 0 0;
  border: 0;
  color: var(--accent);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-in-out-smooth), transform var(--motion-press) var(--ease-out-expo);
}
.team-chat-expand:hover { text-decoration: underline; }
.team-chat-expand:active { transform: scale(0.98); }
/* 自己的气泡底色就是赤陶色，入口换成反白字。 */
.task-board-team-chat .team-chat-msg[data-side="end"] .team-chat-expand { justify-self: end; color: var(--text-inverse); }
/* 仅页面账本结算为前台/贴尾/首次可见的新尾才入场；历史与重挂载静态（R3）。
   行在首次布局即占最终高度，+4px 只作用在绘制层。 */
@keyframes wand-team-msg-in {
  from { opacity: 0; translate: 0 4px; }
}
.task-board-team-chat .chat-message.team-chat-msg[data-arriving],
.task-board-team-chat .chat-message.chat-notice[data-arriving] {
  animation: wand-team-msg-in var(--motion-normal) var(--ease-out-expo);
}
.task-board-team-chat-input {
  position: relative;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.task-board-team-chat-hint { margin: 0 12px; color: var(--text-tertiary); font-size: var(--font-size-xs); }
/* The writing surface, attachment strip, + menu and send phases come from the
   main chat composer. Only the team chat's placement and extra stop action differ. */
.task-board-team-chat-input .input-composer-row { max-width: none; }
.task-board-team-chat-input .team-chat-stop-action { color: var(--danger); }
.task-board-team-chat-input .team-chat-stop-action:hover:not(:disabled) {
  color: var(--danger);
  background: var(--danger-muted);
}

/* ---------- 全文弹层（Portal）：从触发点方向长出，关闭回到原位 ---------- */
/* 弹层渲染在 #overlay-root 里，物理上不在 .task-board-team-chat 这棵树里，
   所以它挂在自己的唯一前缀上（设计 G3），两边都不碰全局 .chat-*。 */
.wand-ui-dialog-content.wand-team-chat-doc-dialog {
  display: flex;
  width: min(720px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  max-height: min(72vh, 640px);
  flex-direction: column;
  overflow: hidden;
}
.wand-ui-dialog-content.wand-team-chat-doc-dialog[data-open] {
  animation: team-chat-doc-in var(--motion-normal) var(--ease-out-expo);
}
.wand-ui-dialog-content.wand-team-chat-doc-dialog[data-ending-style] {
  animation: team-chat-doc-out var(--motion-quick-exit) var(--ease-in-out-smooth);
}
/* 修饰符只设两个自定义属性，translate 与 scale 是独立属性，可以同时动画；
   写成 transform 拼两块会互相覆盖，也会盖掉居中用的 translate(-50%, -50%)。 */
.wand-doc-dx-start { --wand-doc-dx: -10px; }
.wand-doc-dx-end { --wand-doc-dx: 10px; }
.wand-doc-dy-top { --wand-doc-dy: -10px; }
.wand-doc-dy-bottom { --wand-doc-dy: 10px; }
@keyframes team-chat-doc-in {
  from { opacity: 0; translate: var(--wand-doc-dx, 0) var(--wand-doc-dy, 0); scale: 0.98; }
}
@keyframes team-chat-doc-out {
  to { opacity: 0; translate: var(--wand-doc-dx, 0) var(--wand-doc-dy, 0); scale: 0.98; }
}
.team-chat-doc-layer { display: flex; flex: 1 1 auto; flex-direction: column; gap: 8px; min-height: 0; }
.team-chat-doc-layer-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.team-chat-doc-layer-name { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.team-chat-doc-layer-text {
  flex: 1 1 auto;
  min-height: 40px;
  margin: 0;
  padding-right: 4px;
  overflow: auto;
  overscroll-behavior-y: contain;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-base);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ---------- 独立群聊页（侧栏点群聊条目进入）---------- */
/* 主任务钉顶、消息层中间滚动、输入框沉底：整页不跳转，返回即收起。 */
.wand-team-chat-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  padding: 0 28px 20px;
}
.wand-team-chat-body > .task-board-team-chat {
  display: flex;
  width: 100%;
  max-width: 920px;
  min-height: 0;
  margin: 0 auto;
  flex: 1 1 auto;
  flex-direction: column;
}
.wand-team-chat-body .task-board-team-chat-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
}
.wand-team-chat-body .task-board-team-chat-input { flex: 0 0 auto; }
.wand-team-chat-body .team-chat-details[data-open] { max-height: 42vh; overflow-y: auto; overscroll-behavior-y: contain; }
.wand-team-chat-head-meta { display: flex; align-items: center; gap: 10px; }
/* 群聊页头部：面包屑用 variant="title"，末段就是页面 h1，这里只压小整行的导航字号。 */
.wand-team-chat-crumb { font-size: var(--font-size-sm); }
.wand-team-chat-heading-avatar { flex: 0 0 auto; display: inline-flex; align-items: center; }
.wand-team-chat-heading-avatar .wand-team-avatar-stack { padding-top: 0; }
.wand-team-chat-unconfirmed { color: var(--warning); font-size: var(--font-size-xs); }

/* ---------- 群聊页底部「工作任务」二级目录（本次运行派发给成员的工作）---------- */
/* 沉在对话区下方：chat 层仍 flex 撑满、消息内部滚动，这里定高内滚，展开行在原位长高、其余顺势下移。 */
.wand-team-work-tasks {
  padding: 6px 0 0;
  border-top: 1px solid var(--border-subtle);
}
.wand-team-work-tasks-inner { display: grid; gap: 8px; width: 100%; max-width: 920px; margin: 0 auto; }
.wand-team-work-tasks-head { display: flex; align-items: baseline; gap: 10px; }
.wand-team-work-tasks-head h2 { margin: 0; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.wand-team-work-tasks-head small { margin-left: auto; color: var(--text-tertiary); font-size: var(--font-size-xs); font-variant-numeric: tabular-nums; }
.wand-team-work-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.wand-team-work-item { border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-primary); }
.wand-team-work-item[data-status="queued"],
.wand-team-work-item[data-status="skipped"] { opacity: 0.66; }
.wand-team-work-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wand-team-work-head > svg { color: var(--text-muted); transition: transform var(--motion-fast) var(--ease-in-out-smooth); }
.wand-team-work-item[data-open] .wand-team-work-head > svg { transform: rotate(180deg); }
.wand-team-work-seq { color: var(--text-tertiary); font-size: var(--font-size-xs); font-variant-numeric: tabular-nums; }
.wand-team-work-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); }
.wand-team-work-status { color: var(--text-tertiary); font-size: var(--font-size-xs); }
.wand-team-work-item[data-status="running"] .wand-team-work-status { color: var(--info); }
.wand-team-work-item[data-status="done"] .wand-team-work-status { color: var(--success); }
.wand-team-work-item[data-status="failed"] .wand-team-work-status { color: var(--danger); }
/* 原位展开：0fr → 1fr，收起是同一段过渡倒放（§7 要求 7）。 */
.wand-team-work-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows var(--motion-normal) var(--ease-in-out-smooth), opacity var(--motion-fast) var(--ease-in-out-smooth);
}
.wand-team-work-item[data-open] .wand-team-work-body { grid-template-rows: 1fr; opacity: 1; }
.wand-team-work-body-inner { min-height: 0; overflow: hidden; display: grid; gap: 8px; padding: 0 10px; }
.wand-team-work-item[data-open] .wand-team-work-body-inner { padding-bottom: 10px; }
.wand-team-work-member { display: flex; align-items: center; gap: 8px; }
.wand-team-work-member-name { font-size: var(--font-size-sm); }
.wand-team-work-member-duty { overflow: hidden; color: var(--text-tertiary); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.wand-team-work-meta { display: grid; gap: 2px; margin: 0; font-size: var(--font-size-xs); }
.wand-team-work-meta div { display: flex; gap: 8px; }
.wand-team-work-meta dt { flex: none; color: var(--text-tertiary); }
.wand-team-work-meta dd { min-width: 0; margin: 0; overflow: hidden; color: var(--text-secondary); }
.wand-team-work-meta code { overflow: hidden; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.wand-team-work-report {
  max-height: 180px;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 备用候选被跳原因：在当前步骤卡下方原位长高，其余行顺势下移（§7 要求 7）。 */
.task-board-team-step-skips { display: grid; gap: 2px; padding: 0 8px 8px; }
.task-board-team-step-skip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font: inherit;
  font-size: var(--font-size-xs);
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-in-out-smooth);
}
.task-board-team-step-skip-head > svg:first-child { color: var(--warning); flex: 0 0 auto; }
.task-board-team-step-skip-head > span { margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-board-team-step-skip-head > svg:last-child { color: var(--text-muted); transition: transform var(--motion-morph) var(--ease-out-back); }
.task-board-team-step-skips[data-open] .task-board-team-step-skip-head > svg:last-child { transform: rotate(180deg); }
.task-board-team-step-skip-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows var(--motion-normal) var(--ease-in-out-smooth), opacity var(--motion-fast) var(--ease-in-out-smooth);
}
.task-board-team-step-skips[data-open] .task-board-team-step-skip-body { grid-template-rows: 1fr; opacity: 1; }
.task-board-team-step-skip-inner {
  display: grid;
  gap: 4px;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow: hidden;
  list-style: none;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}
.task-board-team-step-skip-inner li { display: grid; gap: 2px; padding: 4px 8px; }
.task-board-team-step-skip-inner strong { color: var(--text-primary); font-weight: var(--font-weight-medium); }
.task-board-team-step-skip-inner span { white-space: pre-wrap; overflow-wrap: anywhere; }
.task-board-team-group > header { display: grid; gap: 2px; margin-bottom: 6px; }
.task-board-team-group > header strong { font-size: var(--font-size-sm); }
.task-board-team-group > header small { color: var(--text-tertiary); font-size: var(--font-size-xs); }

.task-board-team-steps { position: relative; display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; animation: wand-settings-fade-in var(--transition-normal); }
.task-board-team-step { position: relative; display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: start; gap: 10px; }
.task-board-team-step:not(:last-child)::before {
  content: "";
  position: absolute;
  top: 34px;
  bottom: -6px;
  left: 13px;
  width: 1px;
  background: var(--border-subtle);
}
.task-board-team-step > .wand-team-avatar { margin-top: 6px; }
.task-board-team-step-card { min-width: 0; border-radius: var(--radius-sm); background: var(--bg-primary); }
.task-board-team-step[data-kind="leader"] .task-board-team-step-card { background: color-mix(in srgb, var(--warning) 7%, var(--bg-primary)); }
.task-board-team-step[data-status="queued"] .task-board-team-step-card,
.task-board-team-step[data-status="skipped"] .task-board-team-step-card { opacity: 0.66; }
.task-board-team-step-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.task-board-team-step-head svg { color: var(--text-muted); transition: transform var(--transition-fast); }
.task-board-team-step[data-open] .task-board-team-step-head svg { transform: rotate(180deg); }
.task-board-team-step-title { display: grid; min-width: 0; }
.task-board-team-step-title strong,
.task-board-team-step-title small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-board-team-step-title strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); }
.task-board-team-step-title small,
.task-board-team-step-status { color: var(--text-tertiary); font-size: var(--font-size-xs); }
.task-board-team-step[data-status="running"] .task-board-team-step-status { color: var(--info); }
.task-board-team-step[data-status="failed"] .task-board-team-step-status { color: var(--danger); }
.task-board-team-step[data-status="done"] .task-board-team-step-status { color: var(--success); }
.task-board-team-step-preview {
  display: -webkit-box;
  margin: -2px 10px 8px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.task-board-team-step-inner { display: grid; gap: 8px; padding: 0 10px; }
.task-board-team-step[data-open] .task-board-team-step-inner { padding-bottom: 10px; }
.task-board-team-step-inner h4 { margin: 0 0 4px; color: var(--text-tertiary); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.task-board-team-step-inner pre {
  max-height: 320px;
  margin: 0;
  overflow: auto;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-board-team-step-meta { margin: 0; color: var(--text-tertiary); font-size: var(--font-size-xs); }
.task-board-team-manual,
.task-board-team-respond { display: grid; gap: 8px; }

/* 原位展开：0fr → 1fr，收起是同一段过渡倒放。 */
.task-board-team-step-body,
.wand-team-member-body,
.wand-team-run-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows var(--transition-normal), opacity var(--transition-fast);
}
.task-board-team-step[data-open] .task-board-team-step-body,
.wand-team-member[data-open] .wand-team-member-body,
.wand-team-run[data-open] .wand-team-run-body { grid-template-rows: 1fr; opacity: 1; }
.task-board-team-step-inner,
.wand-team-member-inner { min-height: 0; overflow: hidden; }
.wand-team-member-head > svg,
.wand-team-run-head > svg { color: var(--text-muted); transition: transform var(--transition-fast); }
.wand-team-member[data-open] .wand-team-member-head > svg,
.wand-team-run[data-open] .wand-team-run-head > svg { transform: rotate(180deg); }

@media (max-width: 760px) {
  .wand-ai-team-editor-grid { grid-template-columns: minmax(0, 1fr); }
  .wand-team-chat-body { padding: 0 14px 16px; }
  .task-board-team-chat-input .composer-plus-popover { max-width: calc(100% - 8px); }
  .wand-team-work-tasks { padding: 4px 0 0; }
  .wand-teams-layout { grid-template-columns: minmax(0, 1fr); }
  .wand-teams-list { padding: 12px 14px; border-right: 0; }
  .wand-teams-detail { padding: 14px 14px 28px; }
  .wand-teams-page[data-detail] .wand-teams-list { display: none; }
  .wand-teams-page:not([data-detail]) .wand-teams-detail { display: none; }
  .wand-team-run-head { grid-template-columns: auto minmax(0, 1fr) auto auto; }
  .wand-team-run-head small { display: none; }
  .wand-team-candidate { grid-template-columns: auto minmax(0, 1fr); }
  .wand-team-candidate-tools { grid-column: 1 / -1; justify-content: end; }
  /* 窄屏不叠放：非当前视图直接让位，剩下的那条走静态流式自然高度。 */
  .task-board-team-views-stack { display: block; }
  .task-board-team-view { opacity: 1; }
  .task-board-team-view[data-hidden] { display: none; visibility: visible; transition: none; }
  /* 团队详情同理：常驻的另一块面板不占高度，否则窄屏会多出空白滚动区。 */
  .wand-teams-detail-stack { display: block; }
  .wand-teams-detail-pane { opacity: 1; }
  .wand-teams-detail-pane[data-hidden] { display: none; visibility: visible; transition: none; }
}

@media (prefers-reduced-motion: reduce) {
  .task-board-team-step-body,
  .wand-team-work-body,
  .wand-team-work-head > svg,
  .wand-team-member-body,
  .wand-team-run-body,
  .team-chat-goal-body,
  .team-chat-details,
  .team-chat-live-body,
  .task-board-team-step-head svg,
  .wand-team-member-head > svg,
  .wand-team-run-head > svg,
  .wand-team-candidate-tool,
  .wand-team-candidate-tool > svg,
  .wand-team-candidate-add,
  .wand-team-candidate-add > svg,
  .task-board-team-view,
  .task-board-team-step-skip-head,
  .task-board-team-step-skip-head > svg:last-child,
  .task-board-team-step-skip-body,
  .wand-teams-create-icon,
  /* 新回合无需退场清理信号；原生壳也必须瞬时（live 的清理机制保持不动）。 */
  .task-board-team-chat .chat-message.team-chat-msg[data-arriving],
  .task-board-team-chat .chat-message.chat-notice[data-arriving] { animation: none; }
  .task-board-team-chat .team-chat-expand:active { transform: none; }
  /* live 进/退继续用动画结束信号摘除；原生壳没有全局兜底，故两处都用
     不含位移的关键帧和 token 派生的瞬时长度，不能写 animation: none。 */
  .task-board-team-chat .team-chat-live-head {
    animation-name: wand-team-live-reduced;
    animation-duration: calc(var(--motion-fast) * 0);
  }
  .task-board-team-chat .team-chat-live-row[data-leaving] {
    animation-name: wand-team-live-reduced;
    animation-duration: calc(var(--motion-quick-exit) * 0);
  }
  .team-chat-live-card { transition: none; }
  .wand-teams-detail,
  .task-board-team-steps { animation: none; }
  /* 面板改为叠放淡入淡出后，reduce-motion 下退化成瞬时切换。 */
  .wand-teams-detail-pane { transition: none; }
  /* 高级配置是纯位移展开，原生壳没有全局兑底，这里直接去掉过渡。 */
  .wand-employee-advanced,
  .wand-employee-advanced-toggle button > svg { transition: none; }
}

/* ---------- 硅基员工列表与卡片样式 ---------- */
.wand-employees-layout {
  display: block !important;
  max-width: 960px;
  margin: 0 auto;
  padding: 16px 20px 40px;
}
.wand-employee-list {
  display: grid;
  gap: 16px;
  width: 100%;
}
.wand-employee-card.is-archived {
  opacity: 0.65;
}
.wand-employee-card.is-system {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border-subtle));
  background: color-mix(in srgb, var(--accent) 4%, var(--bg-primary));
}
.wand-employee-system-note {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border-subtle));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 6%, var(--bg-primary));
}
.wand-employee-system-note strong {
  color: var(--accent-active);
  font-size: var(--font-size-xs);
}
.wand-employee-system-note span {
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}
.wand-employee-archived-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-tertiary);
  font-size: 11px;
  font-style: normal;
}
.wand-employee-filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}
.wand-employee-filter-toggle input {
  cursor: pointer;
}
.wand-teams-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.wand-teams-toolbar-search {
  flex: 1 1 300px;
  max-width: 400px;
}
.wand-teams-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.wand-settings-field {
  display: grid;
  gap: 6px;
}
.wand-settings-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
}

/* ---------- 统一执行主体选择器样式 ---------- */
.wand-execution-subject-picker {
  display: grid;
  gap: 16px;
}
.wand-subject-group {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}
.wand-subject-group-title {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}
.wand-subject-empty-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
}
.wand-link-btn {
  background: transparent;
  border: 0;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
}
.wand-link-btn:hover {
  color: var(--accent-strong);
}
`;
