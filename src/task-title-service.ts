import type { WandStorage } from "./storage.js";
import type { WandConfig, ProcessEvent } from "./types.js";
import type { OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { generateWandTaskTitle, provisionalTaskTitleFromDescription, TASK_TITLE_MAX_LENGTH } from "./task-title.js";
import { isAutoNameableBoardTask, taskAutoNameSignature, taskAutoNameSourceText } from "./wand-task-sync.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { getErrorMessage } from "./error-utils.js";

export interface AutoTaskTitleOptions {
  config?: WandConfig;
  free?: Pick<OpenRouterFreeModelsService, "resolveForCall">;
  generateTitle?: typeof generateWandTaskTitle;
  cwd?: string;
}

const services = new WeakMap<WandStorage, TaskTitleService>();
const flights = new Set<Promise<void>>();

/** One owner per storage lifetime; mutation notifications, never GET, drive naming. */
export class TaskTitleService {
  private options: AutoTaskTitleOptions;
  private pending = new Map<string, { source: string; signature: string }>();
  private flight: Promise<void> | null = null;
  private controller = new AbortController();
  private disposed = false;
  private unsubscribe: () => void;

  constructor(private storage: WandStorage, options: AutoTaskTitleOptions = {}) {
    this.options = options;
    this.unsubscribe = storage.onTaskTitleChange(() => this.refresh());
    storage.onClose(() => this.dispose());
  }

  ingest(event: ProcessEvent): void {
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === "started" || event.type === "ended" || (data && ("title" in data || "description" in data))) {
      this.storage.notifyTaskTitleChange();
    }
  }

  configure(options: AutoTaskTitleOptions): void {
    this.options = { ...this.options, ...options };
  }

  refresh(options: AutoTaskTitleOptions = {}): void {
    if (this.disposed) return;
    this.configure(options);
    for (const card of this.storage.listWandTasks()) {
      if (!isAutoNameableBoardTask(card)) continue;
      const source = taskAutoNameSourceText(this.storage, card);
      if (!source) continue;
      const signature = taskAutoNameSignature(source);
      if (card.autoTitleSignature === signature) continue;
      const title = provisionalTaskTitleFromDescription(source);
      this.storage.updateWandTask(card.id, { titleSource: "auto", autoTitleSignature: signature,
        ...(title && title !== card.title ? { title } : {}) });
      if (this.options.generateTitle || this.options.config) this.pending.set(card.id, { source, signature });
    }
    if (this.flight || !this.pending.size) return;
    const flight = Promise.resolve().then(() => this.drain());
    this.flight = flight;
    flights.add(flight);
    void flight.finally(() => { flights.delete(flight); if (this.flight === flight) this.flight = null; }).catch(() => {});
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.pending.size) {
      const [id, input] = this.pending.entries().next().value!;
      this.pending.delete(id);
      try {
        const current = this.storage.getWandTask(id);
        if (!current || current.titleSource !== "auto" || current.autoTitleSignature !== input.signature
          || !taskAutoNameSourceText(this.storage, current)) continue;
        const { config, free, generateTitle = generateWandTaskTitle } = this.options;
        const provider = config?.defaultProvider ?? "claude";
        const ai = config ? resolveSystemAiContext({ provider, structuredState: undefined, runner: undefined,
          command: provider === "qoder" ? "qodercli" : provider, selectedModel: null,
          thinkingEffort: config.defaultThinkingEffort }, config, this.storage.getSystemSiliconEmployee(), free, { storage: this.storage }) : {};
        const cwd = (current.workspaceId ? this.storage.getWorkspace(current.workspaceId)?.cwd : undefined) || this.options.cwd
          || config?.defaultCwd || process.cwd();
        const title = await generateTitle(input.source, cwd, config?.language ?? "", { ...ai, signal: this.controller.signal });
        if (this.disposed) return;
        const latest = this.storage.getWandTask(id);
        if (!latest || latest.titleSource !== "auto" || latest.autoTitleSignature !== input.signature
          || !taskAutoNameSourceText(this.storage, latest)) continue;
        const clipped = title.slice(0, TASK_TITLE_MAX_LENGTH);
        if (clipped && clipped !== latest.title) this.storage.updateWandTask(id, { title: clipped });
      } catch (error) {
        if (!this.disposed) console.error(`[WandTask] Failed to auto-generate title for ${id}:`, getErrorMessage(error));
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    this.unsubscribe();
    this.controller.abort();
    if (this.flight) flights.delete(this.flight);
  }
}

export function taskTitleService(storage: WandStorage, options: AutoTaskTitleOptions = {}): TaskTitleService {
  let service = services.get(storage);
  if (!service) { service = new TaskTitleService(storage, options); services.set(storage, service); }
  else service.configure(options);
  return service;
}

export function refreshAutoBoardTaskTitles(storage: WandStorage, options: AutoTaskTitleOptions = {}): void {
  taskTitleService(storage, options).refresh(options);
}

/** Compatibility/test wait, not a shared execution queue. */
export async function whenWandTaskTitlesSettled(): Promise<void> {
  await Promise.resolve();
  while (flights.size) { await Promise.all([...flights]); await Promise.resolve(); }
}
