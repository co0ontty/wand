import type {
  RestartOverlayConfig,
  RestartOverlayRepository,
  RestartOverlayRepositoryOptions,
} from "./types";

export type MemoryRestartOverlayStep = RestartOverlayConfig | Error;

/** Deterministic second adapter; the final step repeats after the sequence ends. */
export class MemoryRestartOverlayRepository implements RestartOverlayRepository {
  readonly calls: Array<{ signal?: AbortSignal }> = [];
  private cursor = 0;

  constructor(public steps: MemoryRestartOverlayStep[]) {}

  async loadConfig(
    options: RestartOverlayRepositoryOptions = {},
  ): Promise<RestartOverlayConfig> {
    this.calls.push({ signal: options.signal });
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const index = Math.min(this.cursor, Math.max(0, this.steps.length - 1));
    const step = this.steps[index] ?? {
      serverInstanceId: "",
      packageVersion: "",
      currentVersion: "",
    };
    this.cursor += 1;
    if (step instanceof Error) throw step;
    return structuredClone(step);
  }
}
