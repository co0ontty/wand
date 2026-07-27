import { cloneSettingsSnapshot } from "./repository";
import type {
  SettingsCommand,
  SettingsCommandResult,
  SettingsExecuteOptions,
  SettingsLoadOptions,
  SettingsRepository,
  SettingsSnapshot,
} from "./types";

export type SettingsMemoryHandler = (
  command: SettingsCommand,
  snapshot: SettingsSnapshot,
) => unknown | Promise<unknown>;

/** Deterministic adapter for UI/unit tests; never touches fetch, storage or native APIs. */
export class MemorySettingsRepository implements SettingsRepository {
  readonly commands: SettingsCommand[] = [];

  constructor(
    private snapshot: SettingsSnapshot,
    private readonly handler?: SettingsMemoryHandler,
  ) {}

  async load(_options?: SettingsLoadOptions): Promise<SettingsSnapshot> {
    return cloneSettingsSnapshot(this.snapshot);
  }

  async execute<C extends SettingsCommand>(
    command: C,
    _options?: SettingsExecuteOptions,
  ): Promise<SettingsCommandResult<C>> {
    this.commands.push(command);
    if (!this.handler) throw new Error(`MemorySettingsRepository 未实现命令：${command.type}`);
    return await this.handler(command, this.snapshot) as SettingsCommandResult<C>;
  }

  replace(snapshot: SettingsSnapshot): void {
    this.snapshot = cloneSettingsSnapshot(snapshot);
  }
}
