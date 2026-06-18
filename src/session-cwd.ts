import { statSync } from "node:fs";
import process from "node:process";

import { getErrorMessage } from "./error-utils.js";
import { normalizeFolderPath } from "./middleware/path-safety.js";

function getNodeErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

export function resolveSessionCwd(cwd: string | null | undefined, fallbackCwd: string | null | undefined): string {
  const raw = cwd?.trim() || fallbackCwd?.trim() || process.cwd();
  const resolved = normalizeFolderPath(raw);

  let fileStat;
  try {
    fileStat = statSync(resolved);
  } catch (error) {
    const code = getNodeErrorCode(error);
    if (code === "ENOENT") {
      throw new Error(`工作目录不存在：${resolved}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`没有权限访问工作目录：${resolved}`);
    }
    throw new Error(`无法访问工作目录：${resolved}（${getErrorMessage(error)}）`);
  }

  if (!fileStat.isDirectory()) {
    throw new Error(`工作目录不是目录：${resolved}`);
  }

  return resolved;
}
