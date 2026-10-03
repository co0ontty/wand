import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const cli = process.env.WAND_DECISION_CLI;
const node = process.env.WAND_DECISION_NODE;
const args = process.argv.slice(2);
if (!cli || !node || !isAbsolute(cli) || !isAbsolute(node)
  || !process.env.WAND_DECISION_TOKEN || args.length !== 1 || !["--stdin", "--status"].includes(args[0])) {
  process.stderr.write("wand-decision: call --stdin or --status inside an enabled Wand structured session; no admin credential fallback.\n");
  process.exitCode = 1;
} else {
  const child = spawn(node, [...(cli.endsWith(".ts") ? ["--import", "tsx"] : []), cli, "decide", ...args], { stdio: "inherit" });
  child.on("error", () => { process.stderr.write("wand-decision: client could not start.\n"); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
}
