export type NewSessionProvider = "claude" | "codex" | "opencode" | "grok" | "qoder" | "pi";

export type NewSessionKind = "structured" | "pty" | "shell";
export type NewSessionPreferenceKind = Exclude<NewSessionKind, "shell">;

export type NewSessionMode =
  | "default"
  | "full-access"
  | "auto-edit"
  | "native"
  | "managed";

export interface NewSessionConfig {
  defaultProvider: NewSessionProvider;
  defaultSessionKind: NewSessionPreferenceKind;
  defaultMode: NewSessionMode;
  defaultCwd: string;
  structuredRunner: string;
}

export interface NewSessionPath {
  path: string;
  name: string;
}

export interface NewSessionDefaults {
  config: NewSessionConfig;
  recentPaths: readonly NewSessionPath[];
}

export interface NewSessionForm {
  provider: NewSessionProvider;
  kind: NewSessionKind;
  cwd: string;
  mode: NewSessionMode;
  worktreeEnabled: boolean;
}

export interface NewSessionPreferencePatch {
  defaultProvider?: NewSessionProvider;
  defaultSessionKind?: NewSessionPreferenceKind;
  defaultMode?: NewSessionMode;
}

export interface NewSessionRuntimeContext {
  effectiveCwd: string;
  selectedModels?: Partial<Record<NewSessionProvider, string>>;
  thinkingEffort?: string;
}

export interface NewSessionTerminalDimensions {
  cols?: number;
  rows?: number;
}

interface NewSessionCreateRequestBase {
  cwd: string;
  mode: NewSessionMode;
  worktreeEnabled: boolean;
  sessionSource: "interactive";
}

interface StructuredNewSessionCreateRequest extends NewSessionCreateRequestBase {
  kind: "structured";
  provider: NewSessionProvider;
  runner: string;
  model?: string;
  thinkingEffort?: string;
}

interface PtyNewSessionCreateRequest extends NewSessionCreateRequestBase {
  kind: "pty";
  provider: NewSessionProvider;
  command: string;
  cols?: number;
  rows?: number;
}

interface ShellNewSessionCreateRequest extends NewSessionCreateRequestBase {
  kind: "shell";
  shell: true;
  cols?: number;
  rows?: number;
}

export type NewSessionCreateRequest =
  | StructuredNewSessionCreateRequest
  | PtyNewSessionCreateRequest
  | ShellNewSessionCreateRequest;

export interface NewSessionCreated {
  id: string;
  [key: string]: unknown;
}

export interface NewSessionLoadOptions {
  signal?: AbortSignal;
}

/**
 * Network seam for the complete new-session workflow. The HTTP adapter owns
 * endpoint selection, response validation, and preference-write ordering.
 */
export interface NewSessionRepository {
  load(options?: NewSessionLoadOptions): Promise<NewSessionDefaults>;
  savePreferences(patch: NewSessionPreferencePatch): Promise<void>;
  suggestPaths(query: string, options?: NewSessionLoadOptions): Promise<readonly NewSessionPath[]>;
  create(request: NewSessionCreateRequest): Promise<NewSessionCreated>;
}

/**
 * Seam back into the streaming legacy shell. React owns the form and HTTP
 * workflow; this adapter hides terminal preparation and session activation.
 */
export interface NewSessionRuntimeAdapter {
  onOpen(): void;
  onClose(): void;
  getContext(): NewSessionRuntimeContext;
  prepareCreate(kind: NewSessionKind): Promise<NewSessionTerminalDimensions>;
  completeCreate(request: NewSessionCreateRequest, created: NewSessionCreated): Promise<void>;
}
