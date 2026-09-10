import path from "node:path";

const NODE_SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

export function executableCommand(executable, args = []) {
  if (NODE_SCRIPT_EXTENSIONS.has(path.extname(executable).toLowerCase())) {
    return {
      executable: process.execPath,
      args: [executable, ...args],
    };
  }
  return { executable, args };
}
