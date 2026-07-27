import { chmodSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cliPath = path.join(root, "dist", "cli.js");

const mode = statSync(cliPath).mode;
chmodSync(cliPath, mode | 0o755);
