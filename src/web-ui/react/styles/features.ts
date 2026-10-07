/** Business controls use Ant Design; only imperative host geometry remains here. */
export const settingsAndQuickCommitStyles = String.raw`
@keyframes wand-settings-fade-in { from { opacity: 0; } to { opacity: 1; } }
`;

export const missionsStyles = "";

export const sessionPickerAndWorktreeStyles = String.raw`
.wand-workspace-agent-model-select, .wand-new-session-model-select { width: 100%; }
`;

/** Portalled library selectors mounted in the imperative composer's compact slots. */
export const composerSelectStyles = String.raw`
.composer-config-select-host { display: inline-flex; flex: 1 1 auto; min-width: 0; max-width: 100%; }
.wand-composer-select-trigger { width: 100%; min-width: 0; }
.wand-composer-select-trigger > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wand-composer-select-content { width: max-content; max-width: min(560px, calc(100vw - 28px)); max-height: min(330px, var(--available-height)); overflow: auto; }
.wand-composer-select-item { max-width: min(530px, calc(100vw - 48px)); }
.wand-composer-select-item .ant-dropdown-menu-title-content { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

/** Pi keeps its session-owned mount and drag/keyboard slider; Ant owns their visuals. */
export const aiTeamsStyles = String.raw`
[data-pi-composer] { position: relative; }
[data-pi-settings-host] { position: absolute; inset-inline-start: 0; bottom: calc(100% + 8px); width: min(640px, 100%); z-index: 55; }
[data-pi-settings-toggle-host] { display: contents; }
.input-composer:has(.permission-actions:not(.hidden)) [data-pi-settings-toggle-host] { display: none; }
.wand-pi-skill-switch:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; border-radius: var(--control-radius); }
`;
