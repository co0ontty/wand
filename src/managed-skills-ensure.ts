import { homedir } from "node:os";
import path from "node:path";
import { installDecisionSkill } from "./decision-skill.js";
import { getErrorMessage } from "./error-utils.js";
import { installSystemSkill } from "./system-skill.js";

export interface ManagedSkillEnsureOutcome {
  name: string;
  status: "synced" | "unchanged" | "failed";
  files: number;
  links: number;
  error?: string;
}

/** 机器级技能发现链接只服务默认安装；隔离配置（开发/测试）各有自己的 canonical 目录，不互相抢占。 */
export function isDefaultConfigPath(configPath: string, home = homedir()): boolean {
  return path.resolve(path.dirname(configPath)) === path.join(home, ".wand");
}

/** 幂等同步包内托管技能：不抛异常、不覆盖用户改动，调用方只在有变化或失败时输出。 */
export async function ensureManagedSkills(configPath: string, home = homedir()): Promise<ManagedSkillEnsureOutcome[]> {
  const installs: Array<[string, () => Promise<{ changed: string[]; linked: string[] }>]> = [
    ["wand-system", async () => installSystemSkill(configPath, undefined, home)],
    ["wand-decision", async () => installDecisionSkill(path.dirname(configPath), undefined, home)],
  ];
  const outcomes: ManagedSkillEnsureOutcome[] = [];
  for (const [name, install] of installs) {
    try {
      const { changed, linked } = await install();
      outcomes.push({
        name,
        status: changed.length || linked.length ? "synced" : "unchanged",
        files: changed.length,
        links: linked.length,
      });
    } catch (error) {
      outcomes.push({ name, status: "failed", files: 0, links: 0, error: getErrorMessage(error) });
    }
  }
  return outcomes;
}

export function formatManagedSkillsEnsureLog(outcomes: readonly ManagedSkillEnsureOutcome[]): string | null {
  const synced = outcomes.filter((outcome) => outcome.status === "synced");
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  if (!synced.length && !failed.length) return null;
  const parts = [
    ...synced.map((outcome) => `${outcome.name}（${outcome.files} 个文件${outcome.links ? `、${outcome.links} 个新链接` : ""}）`),
    ...failed.map((outcome) => `${outcome.name} 未同步：${outcome.error}`),
  ];
  return `[wand] 托管技能${failed.length ? "部分未同步" : "已同步"}：${parts.join("；")}\n`;
}
