/**
 * 按 provider 原生会话 ID 恢复 structured 会话的路由。
 *
 * 两条历史路径含义不同，必须分开表达：
 *  - `codex` / `opencode` / `qoder` 的历史由 Wand 扫描出来，缺 `cwd` 时可以从历史补齐；
 *  - `grok` / `pi` 的恢复 ID 由客户端自己持有，服务端无法反查记录，必须显式带 `cwd`。
 *
 * 以前每个 provider 各抄一份 handler（5 份几乎相同的 200 行）；现在只有一个
 * 恢复流程，provider 之间的差异收敛成 `StructuredResumeSpec` 里的几个字段。
 */

import type { Express, Request, Response } from "express";

import { asyncRoute } from "./express-async.js";
import { getErrorMessage } from "./error-utils.js";
import type { ProcessManager } from "./process-manager.js";
import { isProviderSessionId, isSafeProviderSessionId } from "./resume-policy.js";
import { parseExecutionMode, parseSessionCreationOrigin } from "./server-session-routes.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { WandStorage } from "./storage.js";
import type { ExecutionMode, SessionProvider, SessionRunner, SessionSnapshot } from "./types.js";
import { resolveWorkspaceIdForNewSession } from "./workspace-binding.js";

interface ResumeRequestBody {
  mode?: ExecutionMode;
  cwd?: string;
  worktreeEnabled?: boolean;
  sessionSource?: unknown;
  automationId?: unknown;
}

export interface ResumeRouteDependencies {
  processes: ProcessManager;
  structured: StructuredSessionManager;
  storage: WandStorage;
  defaultMode: ExecutionMode;
  onSessionCreated?: (cwd: string | undefined | null) => void;
  /** 会话快照 → 响应 DTO；由调用方注入以免这里再依赖消息截断层。 */
  toDetailDTO: (snapshot: SessionSnapshot) => unknown;
}

interface StructuredResumeSpec {
  /** 出现在错误文案里的 provider 名，例如 "Codex"。 */
  label: string;
  provider: SessionProvider;
  runner: SessionRunner;
  /** 历史记录里原生 ID 对应的字段名。 */
  nativeIdKey: "claudeSessionId";
  /** UUID 校验（Codex）还是宽松安全字符校验（其余 provider）。 */
  idFormat: "uuid" | "safe";
  /** 历史由 Wand 扫描取得时提供；返回 undefined 表示服务端不认识这个 ID。 */
  findHistory?: (processes: ProcessManager, nativeId: string) => { cwd: string } | undefined;
}

const STRUCTURED_RESUME_SPECS: Array<{ path: string; param: string; spec: StructuredResumeSpec }> = [
  {
    path: "/api/codex-sessions/:nativeId/resume",
    param: "nativeId",
    spec: {
      label: "Codex",
      provider: "codex",
      runner: "codex-cli-exec",
      nativeIdKey: "claudeSessionId",
      idFormat: "uuid",
      findHistory: (processes, nativeId) =>
        processes.listCodexHistorySessions().find((session) => session.claudeSessionId === nativeId),
    },
  },
  {
    path: "/api/opencode-sessions/:nativeId/resume",
    param: "nativeId",
    spec: {
      label: "OpenCode",
      provider: "opencode",
      runner: "opencode-cli-run",
      nativeIdKey: "claudeSessionId",
      idFormat: "safe",
      findHistory: (processes, nativeId) =>
        processes.listOpenCodeHistorySessions().find((session) => session.claudeSessionId === nativeId),
    },
  },
  {
    path: "/api/qoder-sessions/:nativeId/resume",
    param: "nativeId",
    spec: {
      label: "Qoder",
      provider: "qoder",
      runner: "qoder-cli-print",
      nativeIdKey: "claudeSessionId",
      idFormat: "safe",
      findHistory: (processes, nativeId) =>
        processes.listQoderHistorySessions().find((session) => session.claudeSessionId === nativeId),
    },
  },
  {
    path: "/api/grok-sessions/:nativeId/resume",
    param: "nativeId",
    spec: {
      label: "Grok",
      provider: "grok",
      runner: "grok-cli-headless",
      nativeIdKey: "claudeSessionId",
      idFormat: "safe",
    },
  },
  {
    path: "/api/pi-sessions/:nativeId/resume",
    param: "nativeId",
    spec: {
      label: "Pi",
      provider: "pi",
      runner: "pi-cli-json",
      nativeIdKey: "claudeSessionId",
      idFormat: "safe",
    },
  },
];

/** 参数是合法 UUID 时用 `isProviderSessionId`，否则用宽松校验；返回错误文案或 null。 */
function validateNativeId(nativeId: string, spec: StructuredResumeSpec): string | null {
  if (spec.idFormat === "uuid") {
    return isProviderSessionId(nativeId) ? null : `${spec.label} 会话 ID 必须是有效的 UUID。`;
  }
  return isSafeProviderSessionId(nativeId) ? null : `${spec.label} 会话 ID 格式无效。`;
}

export function registerStructuredResumeRoutes(app: Express, deps: ResumeRouteDependencies): void {
  const { processes, structured, storage, defaultMode, onSessionCreated, toDetailDTO } = deps;

  for (const { path, param, spec } of STRUCTURED_RESUME_SPECS) {
    app.post(path, asyncRoute(async (req: Request, res: Response) => {
      const nativeId = String(req.params[param] || "").trim();
      const body = (req.body ?? {}) as ResumeRequestBody;
      try {
        const invalid = validateNativeId(nativeId, spec);
        if (invalid) {
          res.status(400).json({ error: invalid });
          return;
        }

        const history = spec.findHistory?.(processes, nativeId);
        if (spec.findHistory && !history) {
          res.status(400).json({ error: `对应的 ${spec.label} 历史会话不存在，无法恢复。` });
          return;
        }
        // 自持 ID 的 provider（Grok / Pi）无法反查历史，必须由客户端给 cwd。
        const cwd = body.cwd?.trim() || history?.cwd;
        if (!cwd) {
          res.status(400).json({ error: "无法确定工作目录 (cwd)，无法恢复。" });
          return;
        }

        const snapshot = structured.createSession({
          cwd,
          mode: parseExecutionMode(body.mode, defaultMode),
          provider: spec.provider,
          runner: spec.runner,
          worktreeEnabled: body.worktreeEnabled === true,
          [spec.nativeIdKey]: nativeId,
          workspaceId: resolveWorkspaceIdForNewSession(storage, cwd),
          ...parseSessionCreationOrigin(body),
        });
        onSessionCreated?.(cwd);
        res.status(201).json({ resumedClaudeSessionId: nativeId, ...(toDetailDTO(snapshot) as object) });
      } catch (error) {
        res.status(400).json({ error: getErrorMessage(error, `无法按 ${spec.label} 会话 ID 恢复会话。`) });
      }
    }));
  }
}

