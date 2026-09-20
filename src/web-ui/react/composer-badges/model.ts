import type { ComposerPermissionState } from "./controller";

export interface ComposerPermissionSession {
  readonly provider?: string;
  readonly permissionBlocked?: boolean;
  readonly autoApprovePermissions?: boolean;
  readonly pendingEscalation?: {
    readonly requestId?: string;
    readonly reason?: string;
    readonly target?: string;
  } | null;
}

export function resolveComposerPermission(session: ComposerPermissionSession | null | undefined): ComposerPermissionState | null {
  if (!session || session.provider === "codex") return null;
  const escalation = session.pendingEscalation;
  if (!escalation && !session.permissionBlocked) return null;
  const autoApproving = Boolean(session.autoApprovePermissions);
  const label = autoApproving ? "自动批准中..."
    : escalation ? (escalation.reason || "等待授权") + (escalation.target ? ` · ${escalation.target}` : "")
      : "等待授权";
  return { requestId: escalation?.requestId || null, label, autoApproving };
}
