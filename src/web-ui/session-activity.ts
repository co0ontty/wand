/** Shared activity semantics for React chrome and imperative session controls. */
export interface SessionActivitySource {
  readonly sessionKind?: string;
  readonly runner?: string;
  readonly status?: string;
  readonly provider?: string;
  readonly ptyBusy?: boolean;
  readonly providerCliActive?: boolean;
  readonly archived?: boolean;
  readonly permissionBlocked?: boolean;
  readonly structuredState?: { readonly inFlight?: boolean } | null;
}

export interface SessionActivity {
  readonly active: boolean;
  readonly inFlight: boolean;
  readonly ptyRunning: boolean;
  readonly permissionBlocked: boolean;
}

const PROVIDER_CLI_IDS = new Set(["claude", "codex", "opencode", "grok", "qoder", "pi"]);

function isStructured(session: SessionActivitySource): boolean {
  return session.sessionKind === "structured" || session.runner === "claude-cli-print";
}

export function ptyTurnActive(session: SessionActivitySource | null | undefined): boolean {
  if (!session || session.status !== "running" || isStructured(session)) return false;
  return session.provider && PROVIDER_CLI_IDS.has(session.provider) ? session.ptyBusy === true : true;
}

export function computeRunningSignal(session: SessionActivitySource | null | undefined): SessionActivity {
  if (!session || session.archived) {
    return { active: false, inFlight: false, ptyRunning: false, permissionBlocked: false };
  }
  const permissionBlocked = Boolean(session.permissionBlocked);
  const inFlight = isStructured(session) && Boolean(session.structuredState?.inFlight);
  const ptyRunning = ptyTurnActive(session) && session.providerCliActive !== false;
  return { active: inFlight || ptyRunning || permissionBlocked, inFlight, ptyRunning, permissionBlocked };
}

export function formatElapsedShort(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainingSeconds ? ` ${remainingSeconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
}
