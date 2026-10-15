import { accessSync, constants, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseServiceArguments(text) {
  const result = [];
  let value = "", quote = "", started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      if (++i >= text.length) throw new Error("服务参数转义未完成。");
      value += text[i]; started = true;
    } else if (quote) {
      if (char === quote) quote = ""; else value += char;
    } else if (char === "'" || char === '"') {
      quote = char; started = true;
    } else if (/\s/.test(char)) {
      if (started) { result.push(value); value = ""; started = false; }
    } else { value += char; started = true; }
  }
  if (quote) throw new Error("服务参数引号未闭合。");
  if (started) result.push(value);
  return result;
}

export function discoverServiceConfig(serviceFile, platform) {
  let args;
  if (platform === "Darwin") {
    const read = spawnSync("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", serviceFile], { encoding: "utf8" });
    if (read.status !== 0) throw new Error("无法读取旧服务配置，请设置 WAND_CONFIG_PATH 后重试；旧服务未修改。");
    args = JSON.parse(read.stdout);
  } else {
    const line = readFileSync(serviceFile, "utf8").split("\n").find(line => line.startsWith("ExecStart="));
    args = line ? parseServiceArguments(line.slice("ExecStart=".length)) : [];
  }
  if (!Array.isArray(args)) throw new Error("旧服务启动参数无效。");
  const at = args.findIndex(value => value === "-c" || value === "--config");
  const config = at >= 0 ? args[at + 1] : null;
  if (typeof config !== "string" || !path.isAbsolute(config)) {
    throw new Error("旧服务未给出可识别的配置路径，请指定 WAND_CONFIG_PATH；不猜测或替换旧数据。");
  }
  return config;
}

export function chooseInstallPrefix(defaultPrefix, home, configPath) {
  if (configPath && process.getuid?.() === 0 && statSync(configPath).uid !== 0) {
    throw new Error("请以数据所属用户运行安装入口，不要对整个脚本 sudo；系统服务注册会单独提示提权，避免留下无法自更新的 root-owned 包或数据库。");
  }
  const directories = [path.join(defaultPrefix, "lib/node_modules/@co0ontty"), path.join(defaultPrefix, "bin")];
  const writable = directories.every(directory => {
    let ancestor = directory;
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    try { accessSync(ancestor, constants.W_OK); return true; } catch { return false; }
  });
  return writable ? defaultPrefix : path.join(home, ".wand/runtime/npm");
}

/** Same protocol as Web updates/start.sh, including a live parent's lease.
 * Acquire before draining: a competing install must not close task admission.
 * The module is copied into the independent recovery runtime, never loaded
 * from the installation that this transaction is about to replace.
 */
export async function withRecoveryLock(root, guardPath, action) {
  const directory = path.dirname(guardPath);
  const lockModule = path.join(directory, existsSync(path.join(directory, "deployment-lock.js"))
    ? "deployment-lock.js" : "deployment-lock.ts");
  const { acquireDeploymentLock, releaseDeploymentLock } = await import(pathToFileURL(lockModule).href);
  const previous = process.env.WAND_DEPLOYMENT_LOCKS;
  const inherited = previous ? JSON.parse(previous) : [];
  if (!Array.isArray(inherited)) throw new Error("无效的部署锁回执。");
  const lock = acquireDeploymentLock(path.join(root, ".wand-update-lock"), { inherited });
  try {
    process.env.WAND_DEPLOYMENT_LOCKS = JSON.stringify([...inherited, lock]);
    return await action();
  } finally {
    if (previous === undefined) delete process.env.WAND_DEPLOYMENT_LOCKS;
    else process.env.WAND_DEPLOYMENT_LOCKS = previous;
    releaseDeploymentLock(lock);
  }
}

function copyEntry(source, destination) {
  if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
  else cpSync(source, destination, { dereference: false });
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function managedPid(platform, scope) {
  const result = platform === "Darwin"
    ? spawnSync("launchctl", ["print", `${scope === "system" ? "system" : `gui/${process.getuid()}`}/com.wand.web`], { encoding: "utf8", timeout: 5000 })
    : spawnSync("systemctl", [...(scope === "user" ? ["--user"] : []), "show", "wand.service", "--property=MainPID", "--value"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) {
    if (/Could not find (specified )?service/.test(result.stderr ?? "")) return 0;
    return null;
  }
  const value = platform === "Darwin" ? result.stdout.match(/(?:^|\n)\s*pid = (\d+)\s*(?:\n|$)/)?.[1] ?? "0" : result.stdout.trim();
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid >= 0 ? pid : null;
}

function stopManagedService(platform, scope, serviceFile) {
  const command = platform === "Darwin" ? "launchctl" : "systemctl";
  const args = platform === "Darwin"
    ? ["bootout", scope === "system" ? "system" : `gui/${process.getuid()}`, serviceFile]
    : [...(scope === "user" ? ["--user"] : []), "stop", "wand.service"];
  const privileged = scope === "system" && process.getuid?.() !== 0;
  return spawnSync(privileged ? "sudo" : command, privileged ? [command, ...args] : args, { stdio: "inherit" }).status === 0;
}

export async function recoverPreparedInstallation(options) {
  return withRecoveryLock(options.root, options.guardPath, () => applyPreparedInstallation(options));
}

async function applyPreparedInstallation(options) {
  const { prepared, root, bin, configPath, scope, platform, healthPath, guardPath } = options;
  const health = await import(pathToFileURL(healthPath).href);
  const guard = await import(pathToFileURL(guardPath).href);
  const target = path.join(root, "@co0ontty/wand");
  const configDir = path.dirname(configPath);
  let originalPid;
  try { originalPid = JSON.parse(readFileSync(path.join(configDir, "wand.pid"), "utf8")).pid; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const wasRunning = alive(originalPid);
  let stageRoot, backupRoot, backup, oldBin, previousService;
  let movedOld = false, promoted = false, registered = false;
  const serviceFile = scope === "standalone" ? null : platform === "Darwin"
    ? scope === "system" ? "/Library/LaunchDaemons/com.wand.web.plist" : path.join(process.env.HOME, "Library/LaunchAgents/com.wand.web.plist")
    : scope === "system" ? "/etc/systemd/system/wand.service" : path.join(process.env.HOME, ".config/systemd/user/wand.service");
  const cli = (args, privileged = false) => {
    const command = privileged && process.getuid?.() !== 0 ? "sudo" : process.execPath;
    const parameters = [...(command === "sudo" ? [process.execPath] : []), bin, ...args, "-c", configPath];
    const result = spawnSync(command, parameters, { stdio: "inherit" });
    if (result.status !== 0) throw new Error("恢复命令失败: " + args.join(" "));
  };
  const startStandalone = async () => {
    const child = spawn(process.execPath, [bin, "web", "-c", configPath], { detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  };
  try {
    const manifest = JSON.parse(readFileSync(path.join(prepared, "package.json"), "utf8"));
    if (manifest.name !== "@co0ontty/wand" || typeof manifest.version !== "string") throw new Error("下载包身份无效。");
    for (const file of ["dist/cli.js", "dist/server.js", "dist/web-ui/embedded-assets.js"]) {
      if (!statSync(path.join(prepared, file)).isFile()) throw new Error("下载包不完整: " + file);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    stageRoot = mkdtempSync(path.join(path.dirname(target), ".wand-recovery-stage-"));
    const staged = path.join(stageRoot, "wand");
    cpSync(prepared, staged, { recursive: true, dereference: false, verbatimSymlinks: true });
    chmodSync(path.join(staged, "dist/cli.js"), statSync(path.join(staged, "dist/cli.js")).mode | 0o755);
    const probe = spawnSync(process.execPath, [path.join(staged, "dist/cli.js"), "help"], { stdio: "ignore" });
    if (probe.status !== 0) throw new Error("下载包无法启动，旧安装未修改。");
    backupRoot = mkdtempSync(path.join(path.dirname(target), ".wand-recovery-backup-"));
    backup = path.join(backupRoot, "wand");
    oldBin = path.join(backupRoot, "wand-bin");
    try { copyEntry(bin, oldBin); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (serviceFile) {
      const stat = statSync(serviceFile);
      const body = readFileSync(serviceFile);
      const file = path.join(backupRoot, "service-registration");
      writeFileSync(file, body, { mode: 0o600 });
      previousService = { file, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
    }
    if (existsSync(target)) { renameSync(target, backup); movedOld = true; }
    renameSync(staged, target); promoted = true;
    mkdirSync(path.dirname(bin), { recursive: true });
    const pending = path.join(stageRoot, "bin");
    symlinkSync(path.join(target, "dist/cli.js"), pending);
    renameSync(pending, bin);
    // Initialization runs as the caller, not sudo: DB/WAL and the package must
    // remain writable by the service owner for the next Web update.
    cli(["init"]);
    if (scope !== "standalone") {
      registered = true;
      cli(["service:install", ...(scope === "user" ? ["--user"] : [])], scope === "system");
      await health.waitForUpdatedService(configPath, manifest.version, originalPid, options.healthTimeoutMs);
    } else if (wasRunning) {
      process.kill(originalPid, "SIGTERM");
      const deadline = Date.now() + 60_000;
      while (alive(originalPid)) {
        if (Date.now() >= deadline) throw new Error("旧服务没有退出，不启动另一份服务。");
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await startStandalone();
      await health.waitForUpdatedService(configPath, manifest.version, originalPid, options.healthTimeoutMs);
    } else {
      console.log("[wand-recovery] 服务原本未运行；启动命令: " + bin + " web -c " + configPath);
    }
    rmSync(stageRoot, { recursive: true, force: true });
    console.log("[wand-recovery] 更新已验证；旧安装保留在 " + backupRoot);
    return { version: manifest.version, backupRoot };
  } catch (error) {
    // A still-running original process stays online during pre-restart failures.
    // Never replace an unknown/live new runtime without its own admission barrier.
    let originalStillRunning = false;
    if (registered || (wasRunning && !alive(originalPid))) {
      let current;
      try { current = JSON.parse(readFileSync(path.join(configDir, "wand.pid"), "utf8")); } catch {}
      originalStillRunning = !!current && current.pid === originalPid && alive(originalPid);
      if (registered && !originalStillRunning && (!current || !alive(current.pid))) {
        if (managedPid(platform, scope) !== 0) {
          throw new Error("更新未完成，服务管理器的进程状态未知。旧安装与注册备份保留在 " + backupRoot);
        }
        // An empty loaded job must be unloaded, otherwise launchd keeps its new
        // cached arguments even after the old plist is restored on disk.
        if (!stopManagedService(platform, scope, serviceFile) && managedPid(platform, scope) !== 0) {
          throw new Error("服务注册未能安全停止，备份保留在 " + backupRoot);
        }
      }
      if (current && alive(current.pid) && current.pid !== originalPid) {
        try {
          const action = path.join(stageRoot, "stop.mjs");
          writeFileSync(action, `import {readFileSync} from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nconst [file,pid,scope,platform,serviceFile]=process.argv.slice(2);\nconst info=JSON.parse(readFileSync(file,'utf8'));\nif(info.pid!==Number(pid))throw Error('服务实例已变化');\nif(scope==='standalone')process.kill(info.pid,'SIGTERM');\nelse {\n const command=platform==='Darwin'?'launchctl':'systemctl';\n const args=platform==='Darwin'?['bootout',scope==='system'?'system':'gui/'+process.getuid(),serviceFile]:[...(scope==='user'?['--user']:[]),'stop','wand.service'];\n const privileged=scope==='system'&&process.getuid()!==0;\n const r=spawnSync(privileged?'sudo':command,privileged?[command,...args]:args,{stdio:'inherit'});\n if(r.status!==0)throw Error('服务未安全停止');\n}\n`, { mode: 0o600 });
          const code = await guard.waitForCoreTurnsComplete(configPath, 300,
            [process.execPath, action, path.join(configDir, "wand.pid"), String(current.pid), scope, platform, serviceFile ?? ""]);
          if (code !== 0) throw new Error("新版仍未安全停止。");
          const stopDeadline = Date.now() + 60_000;
          while (alive(current.pid)) {
            if (Date.now() >= stopDeadline) throw new Error("新版没有退出。");
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } catch {
          throw new Error("更新未完成，新服务状态不能安全回滚。旧安装和注册备份保留在 " + backupRoot);
        }
      }
    }
    if (promoted) renameSync(target, path.join(stageRoot, "failed-install"));
    if (movedOld) renameSync(backup, target);
    let savedBin = false;
    try { savedBin = !!oldBin && !!lstatSync(oldBin); } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    if (savedBin) { rmSync(bin, { force: true }); copyEntry(oldBin, bin); }
    else if (promoted) rmSync(bin, { force: true });
    if (registered && previousService) {
      const restore = path.join(backupRoot, "restore-service.mjs");
      writeFileSync(restore, `import {readFileSync,writeFileSync,renameSync,chmodSync,chownSync} from 'node:fs';\nconst [source,target,mode,uid,gid]=process.argv.slice(2);\nwriteFileSync(target+'.wand-restore',readFileSync(source));\nchmodSync(target+'.wand-restore',Number(mode));\nchownSync(target+'.wand-restore',Number(uid),Number(gid));\nrenameSync(target+'.wand-restore',target);\n`, { mode: 0o600 });
      const privileged = scope === "system" && process.getuid?.() !== 0;
      const restoreResult = spawnSync(privileged ? "sudo" : process.execPath,
        [...(privileged ? [process.execPath] : []), restore, previousService.file, serviceFile,
          String(previousService.mode), String(previousService.uid), String(previousService.gid)], { stdio: "inherit" });
      if (restoreResult.status !== 0) throw new Error("原服务注册恢复失败，备份保留在 " + backupRoot);
      const reload = platform === "Darwin"
        ? ["launchctl", ["bootstrap", scope === "system" ? "system" : `gui/${process.getuid()}`, serviceFile]]
        : ["systemctl", [...(scope === "user" ? ["--user"] : []), "daemon-reload"]];
      if (!originalStillRunning) spawnSync(privileged ? "sudo" : reload[0], privileged ? [reload[0], ...reload[1]] : reload[1], { stdio: "inherit" });
      if (platform !== "Darwin" && !originalStillRunning) spawnSync(privileged ? "sudo" : "systemctl",
        [...(privileged ? ["systemctl"] : []), ...(scope === "user" ? ["--user"] : []), "start", "wand.service"], { stdio: "inherit" });
    } else if (wasRunning && !alive(originalPid) && savedBin) await startStandalone();
    throw error;
  }
}

let main = false;
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "config") console.log(discoverServiceConfig(args[0], args[1]));
    else if (command === "prefix") console.log(chooseInstallPrefix(args[0], args[1], args[2]));
    else if (command === "apply") {
      const [prepared, root, bin, configPath, scope, platform, healthPath, guardPath] = args;
      await recoverPreparedInstallation({ prepared, root, bin, configPath, scope, platform, healthPath, guardPath });
    } else throw new Error("未知恢复操作。");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
