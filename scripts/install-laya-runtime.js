#!/usr/bin/env node
// Explicit, isolated Apple Silicon runtime. Never installs into the user's/system Python.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChildEnv, systemEnvValue } from "../dist/env-utils.js";

const args = process.argv.slice(2);
let root = path.join(os.homedir(), ".wand", "local-models", "laya"), environment, events = false;
for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  if (option === "--events") events = true;
  else if (option === "--dir" || option === "--environment") {
    const value = args[++index];
    if (!value || value.startsWith("--")) throw Error(`${option} requires a directory`);
    if (option === "--dir") root = path.resolve(value); else environment = path.resolve(value);
  } else if (option === "--help") {
    console.log("node scripts/install-laya-runtime.js [--dir <managed model root>] [--environment <fresh venv directory>] [--events]"); process.exit(0);
  } else throw Error(`Unknown option: ${option}`);
}
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("LAYA-MLX requires Apple Silicon macOS with Metal");
environment ??= path.join(root, "environments", `laya-0.3.0-mlx-0.32.2-${process.pid}`);
if (existsSync(environment)) throw Error("A fresh environment is required; existing Python environments are never overwritten");
const env = buildChildEnv(false, {
  HTTPS_PROXY: systemEnvValue("HTTPS_PROXY"), HTTP_PROXY: systemEnvValue("HTTP_PROXY"), NO_PROXY: systemEnvValue("NO_PROXY"),
  PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
});
function progress(phase, message) {
  if (events) console.log("[wand-model] " + JSON.stringify({ phase, message })); else console.log(message);
}
function run(executable, arguments_, quiet = false) {
  const result = spawnSync(executable, arguments_, { env, shell: false, stdio: quiet || events ? "pipe" : "inherit", encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error("LAYA runtime setup failed; check Python >=3.11, network access to PyPI, free disk space and Metal support");
  return result.stdout?.trim();
}
let completed = false;
try {
  progress("runtime", "检查 Python 3.11+ 与 Apple Silicon 环境");
  const explicit = systemEnvValue("WAND_LAYA_PYTHON_BIN");
  if (explicit && !path.isAbsolute(explicit)) throw Error("WAND_LAYA_PYTHON_BIN must be an absolute trusted path");
  const candidates = explicit ? [explicit] : ["python3.13", "python3.12", "python3.11", "python3"];
  const python = candidates.find(candidate => {
    const probe = spawnSync(candidate, ["--version"], { env, shell: false, encoding: "utf8", timeout: 10000 });
    const version = /Python (\d+)\.(\d+)/.exec(probe.stdout || "");
    return probe.status === 0 && version && Number(version[1]) === 3 && Number(version[2]) >= 11;
  });
  if (!python) throw Error("Python 3.11+ is required; install it or set trusted WAND_LAYA_PYTHON_BIN");
  await mkdir(path.dirname(environment), { recursive: true, mode: 0o700 });
  run(python, ["-m", "venv", environment]);
  const executable = path.join(environment, "bin", "python");
  progress("runtime", "在独立环境安装固定 LAYA 0.3.0 / MLX 0.32.2 依赖");
  run(executable, ["-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple", "--only-binary=:all:",
    "laya-mlx==0.3.0", "mlx==0.32.2", "huggingface-hub==1.33.0"]);
  progress("verifying", "校验运行时与 Metal 能力");
  run(executable, ["-c", "import importlib.metadata as m; import mlx.core as mx; import laya_mlx; assert m.version('laya-mlx') == '0.3.0'; assert m.version('mlx') == '0.32.2'; assert mx.metal.is_available()"], true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const receipt = path.join(root, "runtime.json"), partial = receipt + `.${process.pid}.part`;
  const { rename } = await import("node:fs/promises");
  await writeFile(partial, JSON.stringify({ pythonPath: executable, layaVersion: "0.3.0", mlxVersion: "0.32.2", platform: process.platform, arch: process.arch }) + "\n", { mode: 0o600 });
  await rename(partial, receipt);
  completed = true;
  progress("completed", "LAYA 独立运行时已安装，未修改系统 Python、模型启用状态或技能授权");
} finally {
  if (!completed) await rm(environment, { recursive: true, force: true }).catch(() => {});
}
