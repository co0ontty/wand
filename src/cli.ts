#!/usr/bin/env node

import process from "node:process";
import { ensureConfig, loadConfig, resolveConfigPath, saveConfig } from "./config.js";
import { startServer } from "./server.js";
import { WandConfig } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const configPath = resolveConfigPath(readFlagValue(args, "--config"));

  switch (command) {
    case "init": {
      await ensureConfig(configPath);
      process.stdout.write(`[wand] Config ready at ${configPath}\n`);
      break;
    }
    case "web": {
      await ensureConfig(configPath);
      const config = await loadConfig(configPath);
      await startServer(config, configPath);
      break;
    }
    case "config:path": {
      process.stdout.write(`${configPath}\n`);
      break;
    }
    case "config:show": {
      await ensureConfig(configPath);
      const config = await loadConfig(configPath);
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      break;
    }
    case "config:set": {
      const key = args[1];
      const value = args[2];
      if (!key || typeof value === "undefined") {
        throw new Error("Usage: wand config:set <key> <value>");
      }

      await ensureConfig(configPath);
      const config = await loadConfig(configPath);
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
  wand init                 Create default config in .wand/config.json
  wand web                  Start web console server
  wand config:path          Print resolved config path
  wand config:show          Print current config
  wand config:set           Update a simple config value

Options:
  --config <path>           Use a custom config file path
`);
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
      if (value !== "auto-edit" && value !== "default" && value !== "full-access") {
        throw new Error("defaultMode must be auto-edit, default, or full-access");
      }
      return {
        ...config,
        defaultMode: value
      };
    default:
      throw new Error(`Unsupported config key: ${key}`);
  }
}

main().catch((error) => {
  process.stderr.write(`[wand] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
