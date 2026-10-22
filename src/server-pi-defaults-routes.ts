import type { Express } from "express";
import { asyncRoute } from "./express-async.js";
import { surfaceDomainError } from "./http-error.js";
import { sendRouteError } from "./server-request.js";
import { discoverPiResources, resolvePiResourceSelection } from "./pi-resource-catalog.js";
import {
  defaultPiCliSessionSettings, effectivePiSessionSettings, mergePiSessionDefaults, patchPiSessionSettings,
  type PiSessionSettings,
} from "./pi-session-settings.js";
import type { WandStorage } from "./storage.js";
import type { DecisionService } from "./decision-service.js";
import type { WandConfig } from "./types.js";

export interface PiDefaultsRouteDeps {
  storage: WandStorage;
  config: WandConfig;
  /** 与 pi-settings 面板同一个能力裁决；没有它时自动选择如实报告不可用。 */
  decisions?: { status(): ReturnType<DecisionService["status"]> & Partial<{ notice: string | null }> };
}

const DOMAIN_MESSAGE = /^(Pi 设置必须是对象。|请选择有效的 Skills \/ MCP 列表。|资源选择不能包含路径、命令或其他设置。|资源选择必须是无重复的已安装资源 ID（每类最多64项）。|锁定技能必须是无重复的已安装 Skill ID（最多64项）。|CodeMode 请选择跟随 Pi、关闭、启用或仅 CodeMode。|CodeMode 必须是 off、on 或 only。|基础工具必须是无重复的 Pi 工具列表。|.+ 必须是是否启用（boolean）。|未知 Pi 设置：.+|所选 Skill 已不存在或已被停用，请重新选择；没有改用其他 Skill。|所选 MCP 已不存在，请重新选择；没有连接其他 MCP。)$/;

/**
 * 用户级 Pi 默认设置：新建 Pi CLI 会话的起点。
 *
 * 之前只有「在某个会话里改一次，顺带成为新会话默认」这一条隐式路径，用户在设置页
 * 找不到它；而会话里的写入又只能表达会话本身的选择。这里给出显式入口，语义与
 * `StructuredSessionManager.setPiSettings` 写回默认的那一段保持一致（字段级合并、
 * 资源必须真实存在、不可表达的值直接拒绝）。
 */
export function registerPiDefaultsRoutes(app: Express, deps: PiDefaultsRouteDeps): void {
  const readDefaults = (): PiSessionSettings => deps.storage.getPiSessionDefaults()
    ?? defaultPiCliSessionSettings(deps.config.harness?.compaction?.enabled ?? true);

  const autoResourcesReason = (settings: PiSessionSettings): string => {
    if (settings.localDecision === false) return "已关闭本地决策，自动选择不可用。";
    const status = deps.decisions?.status();
    if (!status?.enabled || !status.supported || !status.configured) {
      return status && "notice" in status && typeof status.notice === "string" && status.notice
        ? status.notice : "本地决策未启用或运行环境不可用；请配置本地决策调用链。";
    }
    return "";
  };

  app.get("/api/pi-settings/defaults", asyncRoute(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const settings = readDefaults();
    const inventory = await discoverPiResources(deps.config, deps.config.defaultCwd);
    const reason = autoResourcesReason(settings);
    res.json({
      // 默认设置表达的是 CLI 会话起点；CLI 的 CodeMode 只归一到 off/on。
      settings: effectivePiSessionSettings(settings, "cli"),
      resourceCatalog: inventory.catalog,
      skillLocksAvailable: inventory.catalog.supported,
      autoResourcesAvailable: inventory.catalog.supported && !reason,
      autoResourcesReason: reason,
      codemodeOnlyAvailable: false,
    });
  }));

  app.patch("/api/pi-settings/defaults", asyncRoute(async (req, res) => {
    try {
      const body = req.body;
      const current = readDefaults();
      // 先按现有默认校验字段本身；再按「只合并本次改动」落库，与会话写入同一套语义。
      const patched = patchPiSessionSettings(current, body);
      const next = mergePiSessionDefaults(current, body);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const touched = body as Record<string, unknown>;
        if (touched.resources !== undefined || touched.lockedSkills !== undefined) {
          const inventory = await discoverPiResources(deps.config, deps.config.defaultCwd);
          if (touched.resources !== undefined) resolvePiResourceSelection(inventory, next.resources ?? { skills: [], mcpServers: [] });
          if (touched.lockedSkills !== undefined) {
            resolvePiResourceSelection(inventory, { skills: next.lockedSkills ?? [], mcpServers: [] });
          }
        }
        if (next.autoResources === true) {
          const reason = autoResourcesReason(next);
          if (reason) throw new Error(reason);
        }
      }
      deps.storage.setPiSessionDefaults(next);
      res.json({ settings: effectivePiSessionSettings(next, "cli") });
    } catch (error) {
      sendRouteError(res, surfaceDomainError(error, DOMAIN_MESSAGE) ?? error, "保存 Pi 默认设置失败。");
    }
  }));
}
