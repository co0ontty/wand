export type RestartOverlayMode = "restart" | "auto-update";

export type RestartOverlayPhase =
  | "idle"
  | "waiting"
  | "checking"
  | "ready"
  | "timed-out";

export interface RestartOverlayConfig {
  serverInstanceId: string;
  packageVersion: string;
  currentVersion: string;
}

export interface RestartOverlayRepositoryOptions {
  signal?: AbortSignal;
}

/** Remote-owned seam for the readiness probe. */
export interface RestartOverlayRepository {
  loadConfig(options?: RestartOverlayRepositoryOptions): Promise<RestartOverlayConfig>;
}

export interface RestartOverlayClock {
  setInterval(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RestartOverlayTarget {
  previousInstanceId: string;
  expectedVersion: string;
}

export interface RestartReadiness {
  ready: boolean;
  instanceReady: boolean;
  versionReady: boolean;
  currentInstanceId: string;
  currentVersion: string;
}

export interface RestartOverlaySnapshot {
  open: boolean;
  mode: RestartOverlayMode;
  phase: RestartOverlayPhase;
  currentVersion: string;
  latestVersion: string;
  target: RestartOverlayTarget;
  attempts: number;
  maxAttempts: number;
  readiness: RestartReadiness;
  lastError: string;
  revision: number;
}

export interface RestartOverlayPresentation {
  title: string;
  description: string;
  liveStatus: string;
}

export interface RestartOverlayControllerDependencies {
  repository: RestartOverlayRepository;
  clock: RestartOverlayClock;
  reloadPage(): void;
}

export interface RestartOverlayController {
  showRestart(previousInstanceId?: string | null, expectedVersion?: string | null): void;
  showAutoUpdate(
    currentVersion: string,
    latestVersion: string,
    previousInstanceId?: string | null,
  ): void;
  manualRefresh(): void;
  isOpen(): boolean;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RestartOverlaySnapshot;
  dispose(): void;
}
