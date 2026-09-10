import { spawn } from "node:child_process";
import { Socket } from "node:net";

import { executableCommand } from "../shared/executable-command.mjs";
import { signalProcessTree } from "../shared/process-tree.mjs";

const [executable, encodedArgs] = process.argv.slice(2);
if (!executable || !encodedArgs) process.exit(2);

const command = executableCommand(executable, JSON.parse(encodedArgs));
const child = spawn(command.executable, command.args, {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

const control = new Socket({ fd: 3, readable: true, writable: false });
const terminateGroup = () => {
  if (process.platform !== "win32") {
    try {
      process.kill(-process.pid, "SIGKILL");
      return;
    } catch {}
  }
  signalProcessTree(child, "SIGKILL");
  process.exit(1);
};
control.once("end", terminateGroup);
control.once("error", terminateGroup);
control.resume();

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
