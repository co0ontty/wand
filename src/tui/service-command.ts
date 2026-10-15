import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCommandInteractive } from "../run-command.js";
import { getErrorMessage } from "../error-utils.js";
import type { CommandResult } from "./commands.js";
import type { LayoutHandle } from "./layout.js";

const activeActions = new WeakSet<LayoutHandle>();

/** Give sudo the real terminal, never route password keystrokes through TUI.
 * Run a separate CLI asynchronously so an embedded server can still drain Core.
 */
export async function runTuiServiceCommand(
  layout: LayoutHandle, command: string, configPath: string,
): Promise<CommandResult> {
  if (activeActions.has(layout)) return { ok: false, message: "服务操作正在进行，请等待完成。" };
  activeActions.add(layout);
  let resume: (() => void) | undefined;
  // Ctrl+C in cooked mode reaches the foreground process group, including
  // sudo. Keep blessed from exiting the parent TUI while the child cancels.
  const onInterrupt = (): void => {};
  process.on("SIGINT", onInterrupt);
  try {
    resume = layout.screen.program.pause();
    const compiled = fileURLToPath(new URL("../cli.js", import.meta.url));
    const cli = existsSync(compiled) ? compiled : fileURLToPath(new URL("../cli.ts", import.meta.url));
    const code = await runCommandInteractive(process.execPath, [
      ...process.execArgv, cli, command, "-c", configPath, "--verbose",
    ]);
    return { ok: code === 0, message: code === 0 ? `${command} 已完成` : `${command} 未完成 (exit ${code})` };
  } catch (error) {
    return { ok: false, message: "服务操作失败", detail: getErrorMessage(error) };
  } finally {
    process.off("SIGINT", onInterrupt);
    try { resume?.(); } finally {
      activeActions.delete(layout);
      layout.screen.render();
    }
  }
}
