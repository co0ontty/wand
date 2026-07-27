/**
 * A React-owned slot is rendered empty. After the first mount, only the
 * injected legacy port may add or remove nodes beneath it.
 */
export interface LegacyHostSlot {
  readonly childNodes: ArrayLike<unknown>;
}

export interface LegacyHostPort<TSlot extends LegacyHostSlot> {
  mount(slot: TSlot): void;
  unmount?(slot: TSlot): void;
}

export interface LegacyHostLease<TSlot extends LegacyHostSlot> {
  readonly slot: TSlot;
  readonly generation: number;
}

/**
 * Owns the imperative lifetime of one empty React slot. A controller is sticky
 * to its first slot so React reconciliation cannot silently move legacy DOM.
 */
export class LegacyHost<TSlot extends LegacyHostSlot> {
  private readonly name: string;
  private readonly port: LegacyHostPort<TSlot>;
  private rememberedSlot: TSlot | null = null;
  private mounted = false;
  private disposed = false;
  private generation = 0;

  constructor(name: string, port: LegacyHostPort<TSlot>) {
    this.name = name;
    this.port = port;
  }

  mount(slot: TSlot): LegacyHostLease<TSlot> {
    if (this.disposed) throw new Error(`${this.name} has been disposed`);
    if (this.rememberedSlot && this.rememberedSlot !== slot) {
      throw new Error(`${this.name} cannot switch to a different slot`);
    }
    if (this.mounted) return this.currentLease();
    if (!this.rememberedSlot && slot.childNodes.length !== 0) {
      throw new Error(`${this.name} requires an empty React slot`);
    }

    this.port.mount(slot);
    this.rememberedSlot = slot;
    this.mounted = true;
    this.generation += 1;
    return this.currentLease();
  }

  unmount(slot?: TSlot): void {
    if (slot && this.rememberedSlot && slot !== this.rememberedSlot) {
      throw new Error(`${this.name} cannot unmount a different slot`);
    }
    if (!this.mounted || !this.rememberedSlot) return;

    const activeSlot = this.rememberedSlot;
    this.mounted = false;
    this.generation += 1;
    this.port.unmount?.(activeSlot);
  }

  currentLease(): LegacyHostLease<TSlot> {
    if (!this.mounted || !this.rememberedSlot || this.disposed) {
      throw new Error(`${this.name} is not mounted`);
    }
    return Object.freeze({ slot: this.rememberedSlot, generation: this.generation });
  }

  isCurrent(lease: LegacyHostLease<TSlot>): boolean {
    return !this.disposed
      && this.mounted
      && this.rememberedSlot === lease.slot
      && this.generation === lease.generation;
  }

  isMounted(): boolean {
    return !this.disposed && this.mounted;
  }

  dispose(): void {
    if (this.disposed) return;
    try {
      this.unmount();
    } finally {
      this.disposed = true;
    }
  }
}
