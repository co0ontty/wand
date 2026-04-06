#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import process from "node:process";
import { ensureConfig, hasConfigFile, isExecutionMode, resolveConfigPath, saveConfig } from "./config.js";
import { WandConfig } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const configPath = resolveConfigPath(readFlagValue(args, "-c") || readFlagValue(args, "--config"));

  switch (command) {
    case "init": {
      await ensureRequiredFiles(configPath);
      break;
    }
    case "web": {
      const config = await ensureRequiredFiles(configPath);
      const { startServer } = await import("./server.js");
      await startServer(config, configPath);
      break;
    }
    case "config:path": {
      process.stdout.write(`${configPath}\n`);
      break;
    }
    case "config:show": {
      const config = await ensureConfig(configPath);
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      break;
    }
    case "config:set": {
      const key = args[1];
      const value = args[2];
      if (!key || typeof value === "undefined") {
        throw new Error("Usage: wand config:set <key> <value>");
      }

      const config = await ensureConfig(configPath);
      const nextConfig = setConfigValue(config, key, value);
      await saveConfig(configPath, nextConfig);
      process.stdout.write(`[wand] Updated ${key} in ${configPath}\n`);
      break;
    }
    case "help":
    default: {
      printHelp();
      break;
    }
  }
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function printHelp(): void {
  process.stdout.write(`wand <command>

Commands:
  wand init                 Create default files in ~/.wand/
  wand web                  Start web console server
  wand config:path          Print resolved config path
  wand config:show          Print current config
  wand config:set           Update a simple config value

Options:
  -c, --config <path>       Use a custom config file (default: ~/.wand/config.json)
`);
}

async function ensureRequiredFiles(configPath: string): Promise<WandConfig> {
  const { ensureDatabaseFile, resolveDatabasePath } = await import("./storage.js");
  const dbPath = resolveDatabasePath(configPath);
  const hadConfig = hasConfigFile(configPath);
  const config = await ensureConfig(configPath);
  const createdDb = ensureDatabaseFile(dbPath);

  if (!hadConfig) {
    process.stdout.write(`[wand] Created default config at ${configPath}\n`);
  } else {
    process.stdout.write(`[wand] Config ready at ${configPath}\n`);
  }

  if (createdDb) {
    process.stdout.write(`[wand] Created SQLite database at ${dbPath}\n`);
  } else {
    process.stdout.write(`[wand] SQLite database ready at ${dbPath}\n`);
  }

  return config;
}

function setConfigValue(
  config: WandConfig,
  key: string,
  value: string
): WandConfig {
  switch (key) {
    case "host":
    case "password":
    case "shell":
    case "defaultCwd":
      return {
        ...config,
        [key]: value
      };
    case "port":
      if (!/^\d+$/.test(value)) {
        throw new Error("port must be a positive integer");
      }
      return {
        ...config,
        port: Number(value)
      };
    case "defaultMode":
      if (!isExecutionMode(value)) {
        throw new Error(`defaultMode must be one of: assist, agent, agent-max, auto-edit, default, full-access, managed, native`);
      }
      return {
        ...config,
        defaultMode: value
      };
    case "https":
      if (value !== "true" && value !== "false") {
        throw new Error("https must be 'true' or 'false'");
      }
      return {
        ...config,
        https: value === "true"
      };
    default:
      throw new Error(`Unsupported config key: ${key}`);
  }
}

main().catch((error) => {
  process.stderr.write(`[wand] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
