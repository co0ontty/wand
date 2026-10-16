/**
 * Platform service registration shared by the TUI, the update helper and relaunch.
 * Owns: scope type, unit/plist paths, installed-scope detection, entrypoint reading.
 * Install/start/stop orchestration stays in tui/commands.ts for now.
 */
import { existsSync } from "node:fs";
import process from "node:process";
import { LaunchdServiceManager } from "./launchd.js";
import { SystemdServiceManager } from "./systemd.js";

/**
 * "system" = Linux /etc/systemd/system/wand.service or macOS /Library/LaunchDaemons (root, boot-time).
 * "user"   = Linux ~/.config/systemd/user/wand.service or macOS ~/Library/LaunchAgents (no root).
 */
export type ServiceScope = "system" | "user";
export const DEFAULT_SERVICE_SCOPE: ServiceScope = "system";
export const SERVICE_SCOPES: readonly ServiceScope[] = ["system", "user"];

export interface ServiceManager {
  readonly platform: "darwin" | "linux";
  /** Path of the installed unit/plist for a scope (may not exist). */
  unitPath(scope: ServiceScope): string;
  /** Command the installed unit runs, or null when absent/unreadable. */
  readEntrypoint(scope: ServiceScope): string | null;
  /** Config used by the installed Server; restart must drain this exact process. */
  readConfigPath(scope: ServiceScope): string | null;
}

/** The manager for the current platform, or null where Wand has no service integration. */
export function currentServiceManager(platform: NodeJS.Platform = process.platform): ServiceManager | null {
  if (platform === "darwin") return new LaunchdServiceManager();
  if (platform === "linux") return new SystemdServiceManager();
  return null;
}

export function servicePathFor(scope: ServiceScope): string {
  return currentServiceManager()?.unitPath(scope) ?? "";
}

/** Scopes whose unit file exists, system first. */
export function detectInstalledServiceScopes(): ServiceScope[] {
  return SERVICE_SCOPES.filter((scope) => {
    const unit = servicePathFor(scope);
    return unit !== "" && existsSync(unit);
  });
}

/** Auto-detect an installed scope; system preferred. */
export function detectInstalledScope(): ServiceScope | null {
  return detectInstalledServiceScopes()[0] ?? null;
}

export function readServiceEntrypoint(scope: ServiceScope): string | null {
  return currentServiceManager()?.readEntrypoint(scope) ?? null;
}

export function readServiceConfigPath(scope: ServiceScope): string | null {
  return currentServiceManager()?.readConfigPath(scope) ?? null;
}
