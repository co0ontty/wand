// Compatibility exports for existing component consumers. Production mounts the
// small deferred-host directly, so this barrel cannot pull the panel into cold JS.
export { PiSettingsHost } from "./deferred-host";
export { PiSettingsPanel, piSettingsScope, panelNotes } from "./panel";
