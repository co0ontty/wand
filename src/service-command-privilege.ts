import path from "node:path";
import process from "node:process";
import { DEFAULT_SERVICE_SCOPE, detectInstalledScope, type ServiceScope } from "./service-manager/index.js";
import { runCommandInteractive } from "./run-command.js";

const MUTATING_SERVICE_COMMANDS = new Set([
  "service:install", "service:uninstall", "service:start", "service:stop", "service:restart",
]);

export function resolveServiceCommandScope(command: string, args: string[]): ServiceScope {
  if (args.includes("--user")) return "user";
  if (args.includes("--system")) return "system";
  return command === "service:install" ? DEFAULT_SERVICE_SCOPE : detectInstalledScope() ?? DEFAULT_SERVICE_SCOPE;
}

export interface ServicePrivilegeRuntime {
  platform: NodeJS.Platform;
  uid: number | undefined;
  interactive: boolean;
  node: string;
  cli: string;
  execArgv: string[];
  run(file: string, args: readonly string[]): Promise<number>;
  report(message: string): void;
}

/** null means continue in this process; a number is the elevated child's exit code.
 * Re-enter the same CLI (not a PATH-resolved wand) before loading service code.
 * Scope/config are pinned so sudo's HOME/PATH cannot target a different service.
 */
export async function elevateServiceCommand(
  command: string, args: string[], configPath: string, scope: ServiceScope,
  runtime: ServicePrivilegeRuntime = {
    platform: process.platform, uid: process.getuid?.(),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    node: process.execPath, cli: process.argv[1], execArgv: process.execArgv,
    run: runCommandInteractive, report: (message) => process.stderr.write(`[wand] ${message}\n`),
  },
): Promise<number | null> {
  if (!MUTATING_SERVICE_COMMANDS.has(command) || scope !== "system" || runtime.uid === 0
    || !["darwin", "linux"].includes(runtime.platform)) return null;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user" || args[i] === "--system") continue;
    if (args[i] === "-c" || args[i] === "--config") { i++; continue; }
    forwarded.push(args[i]);
  }
  if (runtime.interactive) runtime.report("系统服务操作需要管理员权限，正在申请 sudo；请在终端输入密码（输入不会显示）。");
  try {
    const code = await runtime.run("sudo", [
      ...(runtime.interactive ? [] : ["-n"]), "--", runtime.node, ...runtime.execArgv,
      path.resolve(runtime.cli), ...forwarded, "--system", "-c", path.resolve(configPath),
    ]);
    if (code !== 0) runtime.report(runtime.interactive
      ? "管理员授权或服务操作未完成；服务命令已停止，请查看上方错误。"
      : "当前没有交互终端，无法输入 sudo 密码。请在终端运行同一命令以自动申请授权。");
    return code;
  } catch (error) {
    runtime.report(`无法申请 sudo：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
