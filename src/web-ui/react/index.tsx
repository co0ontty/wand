// Public React entry for adapters and tests. The browser runtime imports the
// specific modules it needs (`start-ui`, controllers) instead of this barrel,
// so page-only components stay out of the eager graph.
export { startReactUi } from "./start-ui";
export type { WandOverlay } from "./overlay-controller";
export { configureNewSessionRuntime } from "./new-session/controller";
export { configureFolderPickerRuntime, folderPickerController } from "./folder-picker/controller";
export type { NewSessionCreateRequest, NewSessionCreated, NewSessionRuntimeAdapter } from "./new-session/types";
export type { FolderPickerRuntimeAdapter } from "./folder-picker/types";
export * from "./shell";
export * from "./ui";

export { WandUiProvider, WandUiBoundary, wandTheme } from "./theme";
