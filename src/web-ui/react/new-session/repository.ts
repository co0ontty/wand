import type {
  NewSessionConfig,
  NewSessionCreateRequest,
  NewSessionCreated,
  NewSessionDefaults,
  NewSessionForm,
  NewSessionKind,
  NewSessionLoadOptions,
  NewSessionMode,
  NewSessionPath,
  NewSessionPreferencePatch,
  NewSessionProvider,
  NewSessionRepository,
  NewSessionRuntimeContext,
  NewSessionTerminalDimensions,
} from "./types";

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

const PROVIDERS: readonly NewSessionProvider[] = ["claude", "codex", "opencode", "grok", "qoder"];
const KINDS: readonly NewSessionKind[] = ["structured", "pty"];
const MODES: readonly NewSessionMode[] = [
  "default",
  "full-access",
  "auto-edit",
  "native",
  "managed",
];

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fallback;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

async function readJson(response: Response): Promise<JsonRecord> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`请求失败 (HTTP ${response.status})`);
  }
  const record = isRecord(data) ? data : {};
  if (!response.ok || typeof record.error === "string") {
    const error = new Error(text(record.error, `请求失败 (HTTP ${response.status})`)) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  return record;
}

function normalizeConfig(value: JsonRecord): NewSessionConfig {
  return {
    defaultProvider: oneOf(value.defaultProvider, PROVIDERS, "claude"),
    defaultSessionKind: oneOf(value.defaultSessionKind, KINDS, "structured"),
    defaultMode: oneOf(value.defaultMode, MODES, "default"),
    defaultCwd: text(value.defaultCwd),
    structuredRunner: text(value.structuredRunner, "cli"),
  };
}

function normalizePaths(value: unknown): NewSessionPath[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim()) return [];
    return [{
      path: item.path,
      name: text(item.name, item.path.split("/").filter(Boolean).at(-1) ?? item.path),
    }];
  });
}

export function supportedModes(provider: NewSessionProvider): readonly NewSessionMode[] {
  if (provider === "codex") return ["full-access"];
  if (provider === "opencode" || provider === "grok") return ["default", "full-access", "managed"];
  if (provider === "qoder") return ["default", "full-access", "auto-edit", "managed"];
  return ["default", "full-access", "auto-edit", "native", "managed"];
}

export function safeMode(
  provider: NewSessionProvider,
  requested: NewSessionMode,
  fallback: NewSessionMode = "default",
): NewSessionMode {
  const supported = supportedModes(provider);
  if (supported.includes(requested)) return requested;
  if (supported.includes(fallback)) return fallback;
  return supported[0];
}

function structuredRunner(provider: NewSessionProvider, configured: string): string {
  if (provider === "codex") return "codex-cli-exec";
  if (provider === "opencode") return "opencode-cli-run";
  if (provider === "grok") return "grok-cli-headless";
  if (provider === "qoder") return "qoder-cli-print";
  return configured === "sdk" || configured === "claude-sdk"
    ? "claude-sdk"
    : "claude-cli-print";
}

function ptyCommand(provider: NewSessionProvider): string {
  return provider === "qoder" ? "qodercli" : provider;
}

export function buildCreateRequest(
  form: NewSessionForm,
  defaults: NewSessionConfig,
  context: NewSessionRuntimeContext,
  dimensions: NewSessionTerminalDimensions = {},
): NewSessionCreateRequest {
  const cwd = form.cwd.trim() || context.effectiveCwd.trim() || defaults.defaultCwd;
  const mode = safeMode(form.provider, form.mode, defaults.defaultMode);
  const base = {
    provider: form.provider,
    cwd,
    mode,
    worktreeEnabled: form.worktreeEnabled === true,
    sessionSource: "interactive" as const,
  };

  if (form.kind === "pty") {
    const cols = Number.isFinite(dimensions.cols) && (dimensions.cols ?? 0) > 0
      ? dimensions.cols
      : undefined;
    const rows = Number.isFinite(dimensions.rows) && (dimensions.rows ?? 0) > 0
      ? dimensions.rows
      : undefined;
    return {
      ...base,
      kind: "pty",
      command: ptyCommand(form.provider),
      cols,
      rows,
    };
  }

  const model = context.selectedModels?.[form.provider]?.trim();
  const thinkingEffort = context.thinkingEffort?.trim();
  return {
    ...base,
    kind: "structured",
    runner: structuredRunner(form.provider, defaults.structuredRunner),
    model: model || undefined,
    thinkingEffort: thinkingEffort || undefined,
  };
}

export class HttpNewSessionRepository implements NewSessionRepository {
  private preferenceWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  async load(options: NewSessionLoadOptions = {}): Promise<NewSessionDefaults> {
    await this.preferenceWrite.catch(() => undefined);
    const configResponse = await this.fetchImpl("/api/config", {
      credentials: "same-origin",
      signal: options.signal,
    });
    const config = normalizeConfig(await readJson(configResponse));
    const recentPaths = await this.fetchImpl("/api/recent-paths", {
      credentials: "same-origin",
      signal: options.signal,
    })
      .then(async (response) => {
        if (!response.ok) return [];
        return normalizePaths(await response.json());
      })
      .catch((error) => {
        if (options.signal?.aborted) throw error;
        return [];
      });
    return { config, recentPaths };
  }

  savePreferences(patch: NewSessionPreferencePatch): Promise<void> {
    if (Object.keys(patch).length === 0) return this.preferenceWrite;
    const write = this.preferenceWrite
      .catch(() => undefined)
      .then(async () => {
        const response = await this.fetchImpl("/api/settings/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(patch),
        });
        await readJson(response);
      });
    this.preferenceWrite = write;
    return write;
  }

  async suggestPaths(
    query: string,
    options: NewSessionLoadOptions = {},
  ): Promise<readonly NewSessionPath[]> {
    const response = await this.fetchImpl(`/api/path-suggestions?q=${encodeURIComponent(query.trim())}`, {
      credentials: "same-origin",
      signal: options.signal,
    });
    if (!response.ok) return [];
    return normalizePaths(await response.json());
  }

  async create(request: NewSessionCreateRequest): Promise<NewSessionCreated> {
    const structured = request.kind === "structured";
    const endpoint = structured ? "/api/structured-sessions" : "/api/commands";
    const body = structured
      ? {
          cwd: request.cwd,
          mode: request.mode,
          provider: request.provider,
          runner: request.runner,
          worktreeEnabled: request.worktreeEnabled,
          model: request.model,
          thinkingEffort: request.thinkingEffort,
          sessionSource: request.sessionSource,
        }
      : {
          command: request.command,
          provider: request.provider,
          cwd: request.cwd,
          mode: request.mode,
          worktreeEnabled: request.worktreeEnabled,
          cols: request.cols,
          rows: request.rows,
          sessionSource: request.sessionSource,
        };
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const created = await readJson(response);
    if (typeof created.id !== "string" || !created.id) {
      throw new Error("服务端未返回新会话 ID。");
    }
    return created as NewSessionCreated;
  }
}

export const httpNewSessionRepository = new HttpNewSessionRepository();
