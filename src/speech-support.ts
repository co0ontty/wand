import { execFile } from "node:child_process";
import { buildChildEnv, systemEnvValue } from "./env-utils.js";

export interface SpeechSupport { supported: boolean; reason: string | null; }

function available(command: string, args = ["--version"]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { env: buildChildEnv(true), timeout: 5000, maxBuffer: 16_384, windowsHide: true }, (error) => resolve(!error));
  });
}

/** Fixed, read-only tool probes; never install anything during status polling. */
export async function speechSupport(runtimeAvailable: boolean): Promise<SpeechSupport> {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    return { supported: false, reason: "服务端语音识别仅支持 macOS、Linux 和 Windows。" };
  }
  if (runtimeAvailable) return { supported: true, reason: null };
  if (systemEnvValue("WAND_WHISPER_BIN")) return { supported: false, reason: "配置的语音运行时不可用，请管理员检查 WAND_WHISPER_BIN。" };
  const tools: Array<[string, Promise<boolean>]> = [
    ["Git", available("git")], ["CMake", available("cmake")],
    ["C++ 编译器", process.platform === "win32" ? available("cl", ["/help"]) : available("c++")],
    ...(process.platform === "win32" ? [] : [["Make", available("make")] as [string, Promise<boolean>]]),
  ];
  const results = await Promise.all(tools.map(async ([label, probe]) => await probe ? null : label));
  const missing = results.filter(Boolean);
  return missing.length ? { supported: false, reason: `缺少可用的 ${missing.join("、")}，安装后重新打开此页即可启用。` }
    : { supported: true, reason: null };
}
