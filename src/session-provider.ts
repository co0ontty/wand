import { constants, accessSync, statSync } from "node:fs";
import path from "node:path";

import type { SessionProvider } from "./types.js";
import { providerCliCommand } from "./provider-catalog.js";

// Provider 列表、别名、展示名与推断规则全部收敛在 src/provider-catalog.ts（浏览器层同用）。
// 这里只保留服务端特有的、需要 node:fs 的能力。
export {
  SESSION_PROVIDERS,
  isSessionProvider,
  providerCliCommand,
  providerDisplayName,
  inferProviderFromRunner,
  inferProviderFromCommand,
  normalizeProviderId,
} from "./provider-catalog.js";

/**
 * 不启动 shell 也能判断某个 provider 的 CLI 是否在 PATH 上（与子进程 PATH 一致）。
 * 用于多候选降级时跳过没安装的工具，避免白等一次 spawn 失败。
 */
export function providerCliInstalled(provider: SessionProvider, pathValue = process.env.PATH ?? ""): boolean {
  const command = providerCliCommand(provider);
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    try {
      const executable = path.join(directory, command);
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return true;
    } catch { /* 检查下一个 PATH 目录 */ }
  }
  return false;
}
