#!/usr/bin/env node
// Explicit host-side installation; admin model setup may launch this fixed script, never arbitrary HTTP commands.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChildEnv } from "../dist/env-utils.js";

const SOURCE_COMMIT = "2eeeba56e9edd762b4b38467bab96c2517163158"; // whisper.cpp v1.8.3
const args = process.argv.slice(2);
let backend = "auto";
let root = path.join(os.homedir(), ".wand", "speech");
let workDirectory;
let events = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--backend") backend = args[++i];
  else if (args[i] === "--events") events = true;
  else if (args[i] === "--work-dir") {
    const directory = args[++i];
    if (!directory || directory.startsWith("--")) throw new Error("--work-dir requires a directory");
    workDirectory = path.resolve(directory);
  }
  else if (args[i] === "--dir") {
    const directory = args[++i];
    if (!directory || directory.startsWith("--")) throw new Error("--dir requires an installation directory");
    root = path.resolve(directory);
  }
  else if (args[i] === "--help") {
    console.log("node scripts/install-speech-runtime.js [--backend auto|cpu|metal|cuda] [--dir ~/.wand/speech]");
    process.exit(0);
  } else throw new Error(`Unknown option: ${args[i]}`);
}
if (!["auto", "cpu", "metal", "cuda"].includes(backend)) throw new Error("Invalid backend");
if (!["darwin", "linux", "win32"].includes(process.platform)) throw new Error("Supported hosts: macOS, Linux, Windows");
if (backend === "auto") backend = process.platform === "darwin" ? "metal" : "cpu";
if (backend === "metal" && process.platform !== "darwin") throw new Error("Metal requires macOS");

function progress(phase, message) {
  if (events) console.log("[wand-model] " + JSON.stringify({ phase, message })); else console.log(message);
}
function run(command, arguments_, cwd, quiet = false) {
  const result = spawnSync(command, arguments_, { cwd, env: buildChildEnv(true), shell: false, stdio: quiet || events ? "pipe" : "inherit", encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: install Git, CMake and a C++ toolchain first (CUDA also needs its toolkit)`);
  return result.stdout?.trim();
}
const work = workDirectory ?? await mkdtemp(path.join(os.tmpdir(), "wand-whisper-build-"));
if (workDirectory) await mkdir(workDirectory, { recursive: true, mode: 0o700 });
const staging = path.join(root, `bin-staging-${process.pid}`);
const bin = path.join(root, "bin");
const backup = path.join(root, `bin-previous-${process.pid}`);
try {
  progress("runtime", "准备固定 whisper.cpp v1.8.3 源码");
  run("git", ["init", work], work);
  run("git", ["remote", "add", "origin", "https://github.com/ggml-org/whisper.cpp.git"], work);
  run("git", ["fetch", "--depth", "1", "origin", SOURCE_COMMIT], work);
  run("git", ["checkout", "--detach", "FETCH_HEAD"], work);
  if (run("git", ["rev-parse", "HEAD"], work, true) !== SOURCE_COMMIT) throw new Error("Source revision mismatch");
  progress("runtime", `配置 ${backend.toUpperCase()} 运行时与编译工具链`);
  run("cmake", ["-S", work, "-B", path.join(work, "build"), "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_CURL=OFF", "-DGGML_NATIVE=OFF",
    `-DGGML_METAL=${backend === "metal" ? "ON" : "OFF"}`, "-DGGML_METAL_EMBED_LIBRARY=ON",
    `-DGGML_CUDA=${backend === "cuda" ? "ON" : "OFF"}`], work);
  progress("runtime", "编译 whisper.cpp，仅安装可选语音组件");
  run("cmake", ["--build", path.join(work, "build"), "--config", "Release", "--target", "whisper-cli", "-j", String(Math.min(8, os.availableParallelism()))], work);
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const candidates = [path.join(work, "build", "bin", "Release"), path.join(work, "build", "bin")];
  const built = candidates.find((directory) => existsSync(path.join(directory, name)));
  if (!built) throw new Error("whisper-cli was not produced");
  progress("verifying", "校验语音运行时可执行文件");
  run(path.join(built, name), ["--help"], work, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await cp(built, staging, { recursive: true });
  if (existsSync(bin)) await rename(bin, backup);
  try { await rename(staging, bin); } catch (error) { if (existsSync(backup)) await rename(backup, bin); throw error; }
  await writeFile(path.join(root, "runtime.json"), JSON.stringify({ version: "1.8.3", sourceCommit: SOURCE_COMMIT, backend, platform: process.platform, arch: process.arch }, null, 2) + "\n", { mode: 0o600 });
  await rm(backup, { recursive: true, force: true });
  progress("completed", `whisper.cpp v1.8.3 (${backend}) 已安装；未改变模型启用状态`);
} finally {
  await rm(work, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
}
