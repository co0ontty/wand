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
.team-chat-office-head small { margin-left: auto; color: var(--text-tertiary); font-size: var(--font-size-xs); }
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
  gap: 8px;
  max-height: 360px;
  padding: 4px 2px;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}
/* 子任务层：左侧一道导轨 + 状态色，和主任务/用户发言拉开层级。 */
.team-chat-step {
  gap: 4px;
  margin-left: 10px;
  padding-left: 10px;
  border-left: 2px solid var(--border-subtle);
}
.team-chat-step[data-status="running"] { border-left-color: var(--info); }
.team-chat-step[data-status="done"] { border-left-color: var(--success); }
.team-chat-step[data-status="failed"] { border-left-color: var(--danger); }
.team-chat-step-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.team-chat-step-head .pixel-avatar { flex: 0 0 auto; }
.team-chat-step-chip {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-size: var(--font-size-xs);
}
.team-chat-step-chip[data-ok] { color: var(--success); }
.team-chat-step[data-status="failed"] .team-chat-step-chip { color: var(--danger); }

/* ---------- 正在输出的成员（§4.9 live 卡片）---------- */
/* 两段式进场（与 Android 群聊同拍）：头像 + 名字行先出现，气泡卡片隔一拍再长出；
   收起仍是同一段动画倒放。卡片尺寸固定，文本在里面滚，所以长内容不顶行高。 */
@keyframes wand-team-live-grow {
  from { opacity: 0; transform: translateX(-10px); }
}
.team-chat-live-row {
  margin-left: 10px;
  padding-left: 10px;
  border-left: 2px solid var(--info);
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
.team-chat-live-head .pixel-avatar { flex: 0 0 auto; }
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
  animation: wand-team-live-grow var(--motion-normal) var(--ease-out-expo) both;
  animation-delay: var(--motion-fast);
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

/* 主任务层：负责人决策是公告卡，派工渲染成任务条目，不跟成员报告混在一起。 */
.team-chat-plan {
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}
.team-chat-plan-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.team-chat-plan-text { margin: 0; color: var(--text-primary); font-size: var(--font-size-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.team-chat-plan-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.team-chat-plan-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  font-size: var(--font-size-xs);
}
.team-chat-plan-member { color: var(--accent); font-weight: var(--font-weight-semibold); }
.team-chat-plan-title { color: var(--text-primary); }
.team-chat-plan-wait { color: var(--text-tertiary); }

/* 长报告/长目标：收起给行数截断的预览，展开在原位长高（§7 要求 7）。 */
.team-chat-step-preview {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
}
.team-chat-step-body,
.team-chat-goal-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows var(--transition-normal), opacity var(--transition-fast);
}
.team-chat-step-body[data-open],
.team-chat-goal-body[data-open] { grid-template-rows: 1fr; opacity: 1; }
.team-chat-step-body-inner,
.team-chat-goal-body-inner { min-height: 0; overflow: hidden; }
.team-chat-step-body-text {
  max-height: 360px;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font: inherit;
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.team-chat-expand {
  justify-self: start;
  padding: 0;
  border: 0;
  color: var(--accent);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.team-chat-expand:hover { text-decoration: underline; }
.task-board-team-chat-input { display: grid; gap: 8px; }
.task-board-team-chat-hint { margin: 0; color: var(--text-tertiary); font-size: var(--font-size-xs); }

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
.wand-team-chat-head-meta { display: flex; align-items: center; gap: 10px; }
/* 群聊页头部：面包屑用 variant="title"，末段就是页面 h1，这里只压小整行的导航字号。 */
.wand-team-chat-crumb { font-size: var(--font-size-sm); }
.wand-team-chat-provider { color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.wand-team-chat-unconfirmed { color: var(--warning); font-size: var(--font-size-xs); }
.task-board-team-chat .pixel-avatar .wand-team-avatar-cat { width: 100%; height: 100%; }

/* ---------- 群聊页底部「工作任务」二级目录（本次运行派发给成员的工作）---------- */
/* 沉在对话区下方：chat 层仍 flex 撑满、消息内部滚动，这里定高内滚，展开行在原位长高、其余顺势下移。 */
.wand-team-work-tasks {
  flex: 0 0 auto;
  max-height: 46vh;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  padding: 6px 28px 20px;
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
  .wand-team-work-tasks { max-height: 40vh; padding: 4px 14px 16px; }
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
  .team-chat-step-body,
  .team-chat-goal-body,
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
  /* live 行的长出动画不写进这条列表：animation: none 会让 animationend 不来，退场行撤不掉。
     全局 reduce-motion 已经把时长压到近零并照常派发事件，退场仍然瞬时。 */
  .team-chat-live-card { transition: none; }
  .wand-teams-detail,
  .task-board-team-steps { animation: none; }
  /* 面板改为叠放淡入淡出后，reduce-motion 下退化成瞬时切换。 */
  .wand-teams-detail-pane { transition: none; }
  /* 两段式进场在 reduce-motion 下不留间隔：时长由全局规则压到近零，延迟这里归零，
     否则卡片会比头名晚一拍出现。 */
  .team-chat-live-head,
  .team-chat-live-card { animation-delay: 0s; }
}
`;
