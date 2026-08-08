import { runTerminalDaemon } from "../../src/terminal-daemon-server.js";

const configPath = process.argv[2];
if (!configPath) throw new Error("config path is required");
await runTerminalDaemon(configPath);
