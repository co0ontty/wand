import os from "node:os";

export interface DecisionHardwareSnapshot { platform: string; arch: string; memoryBytes: number; availableBytes: number; cpuCount: number; metal?: boolean; }
export interface DecisionHardwareAssessment {
  suitable: boolean;
  code: "ready" | "platform" | "metal" | "memory" | "cpu";
  message: string;
  memoryGiB: number;
  availableGiB: number;
  cpuCount: number;
  minimumMemoryGiB: number;
}
export function assessDecisionHardware(value: DecisionHardwareSnapshot): DecisionHardwareAssessment {
  const gib = 1024 ** 3, memoryGiB = Math.round(value.memoryBytes / gib * 10) / 10, availableGiB = Math.round(value.availableBytes / gib * 10) / 10;
  const base = { memoryGiB, availableGiB, cpuCount: value.cpuCount, minimumMemoryGiB: 8 };
  const insufficient = "当前机器性能或平台条件不足，建议配置「决策专家」员工的调用链，通过备用模型使用。";
  if (value.platform !== "darwin" || value.arch !== "arm64") return { ...base, suitable: false, code: "platform", message: `LAYA 本地决策需要 Apple Silicon macOS / Metal。${insufficient}` };
  if (value.metal === false) return { ...base, suitable: false, code: "metal", message: `当前 Metal 不可用。${insufficient}` };
  if (value.memoryBytes < 7.5 * gib) return { ...base, suitable: false, code: "memory", message: `当前机器性能不够（内存 ${memoryGiB} GiB，建议至少 8 GiB）。请配置「决策专家」员工调用链使用备用模型。` };
  if (value.cpuCount < 4) return { ...base, suitable: false, code: "cpu", message: `当前机器性能不够（可用 CPU ${value.cpuCount} 核，建议至少 4 核）。请配置「决策专家」员工调用链。` };
  // Darwin's free memory excludes reclaimable cache. Don't falsely reject an otherwise capable Mac based on that number alone.
  return { ...base, suitable: true, code: "ready", message: "本机基本配置满足 LAYA 本地决策要求；实际运行时与 Metal 能力仍需初始化验证。" };
}
export function decisionHardware(): DecisionHardwareAssessment {
  return assessDecisionHardware({ platform: process.platform, arch: process.arch, memoryBytes: os.totalmem(), availableBytes: os.freemem(), cpuCount: os.availableParallelism() });
}
