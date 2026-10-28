import * as React from "react";
import { Empty, Flex, Segmented, Typography } from "antd";
import { WandButton, WandIcon, WandSelect, WandSwitch } from "../ui";
import { SettingsSection, SettingsStatus } from "./fields";
import { piDefaultsRepository } from "./pi-defaults-repository";
import { piResourceSettingsConfirmed, piSkillMode, piSkillModePatch } from "../../../pi-session-settings.js";
import type { PiResourceItem, PiSessionSettings, PiSessionSettingsPatch, PiSkillMode } from "../../../pi-session-settings.js";

/** 用户级默认设置的读回形状；与会话面板共用同一份资源目录与能力字段。 */
export interface PiDefaultsSnapshot {
  settings: PiSessionSettings;
  resourceCatalog: { skills: PiResourceItem[]; mcpServers: PiResourceItem[]; supported: boolean; reason: string };
  skillLocksAvailable: boolean;
  autoResourcesAvailable: boolean;
  autoResourcesReason: string;
  codemodeOnlyAvailable: boolean;
}

const CODEMODE_OPTIONS = [
  { value: "follow", label: "跟随 Pi 配置" },
  { value: "off", label: "关闭" },
  { value: "on", label: "启用" },
];

const MODES: PiSkillMode[] = ["off", "on", "locked"];
const MODE_LABELS: Record<PiSkillMode, string> = { off: "关闭", on: "开启", locked: "锁定" };

/**
 * Pi 会话默认：新建 Pi CLI 会话起步用的设置。
 *
 * 与会话内面板共用 `pref:piSessionDefaults`，但这里改的是「之后的默认」本身；
 * 会话里的改动按字段合并回默认，不会把别处已开启的开关拉回旧值。
 */
export function PiDefaultsPanel(): React.ReactElement {
  const [data, setData] = React.useState<PiDefaultsSnapshot | null>(null);
  const [phase, setPhase] = React.useState<"loading" | "ready" | "saving" | "saved" | "failed">("loading");
  const [message, setMessage] = React.useState("正在读取 Pi 默认设置…");
  const [query, setQuery] = React.useState("");
  const generation = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    const revision = ++generation.current;
    piDefaultsRepository.load(controller.signal).then((result) => {
      if (generation.current !== revision) return;
      setData(result);
      setPhase("ready");
      setMessage(result.resourceCatalog.supported ? "改动会保存为新建 Pi CLI 会话的默认。" : result.resourceCatalog.reason);
    }).catch((error: unknown) => {
      if (generation.current !== revision || controller.signal.aborted) return;
      setPhase("failed");
      setMessage(error instanceof Error ? error.message : "读取失败，请重试。");
    });
    return () => { generation.current += 1; controller.abort(); };
  }, []);

  async function save(patch: PiSessionSettingsPatch): Promise<void> {
    if (!data || phase === "saving") return;
    const revision = ++generation.current;
    setPhase("saving");
    setMessage("正在保存 Pi 默认设置…");
    try {
      const result = await piDefaultsRepository.save(patch);
      if (generation.current !== revision) return;
      if (!piResourceSettingsConfirmed(data.settings, patch, result.settings)) {
        throw new Error("服务端未确认本次选择，请重开面板核对实际设置。");
      }
      if (patch.autoResources !== undefined && (result.settings.autoResources === true) !== patch.autoResources) {
        throw new Error("服务端未确认自动选择设置，请重新读取核对。");
      }
      if (patch.codemodeOverride !== undefined && (result.settings.codemodeOverride ?? null) !== patch.codemodeOverride) {
        throw new Error("服务端未确认 CodeMode 设置，请重新读取核对。");
      }
      if (patch.localDecision !== undefined && result.settings.localDecision !== patch.localDecision) {
        throw new Error("服务端未确认本地决策设置，请重新读取核对。");
      }
      setData((current) => current ? { ...current, settings: result.settings } : current);
      setPhase("saved");
      setMessage("已保存 · 之后新建的 Pi CLI 会话以它起步");
    } catch (error) {
      if (generation.current !== revision) return;
      setPhase("failed");
      setMessage(error instanceof Error ? error.message : "保存失败，原默认设置未改变。");
    }
  }

  const settings = data?.settings;
  const disabled = !data || phase === "loading" || phase === "saving";
  const needle = query.trim().toLocaleLowerCase();
  const match = (item: PiResourceItem): boolean => `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle);

  function toggleResource(kind: "skills" | "mcpServers", id: string, checked: boolean): void {
    if (!settings) return;
    const resources = settings.resources ?? { skills: [], mcpServers: [] };
    void save({ resources: { ...resources, [kind]: checked
      ? [...new Set([...resources[kind], id])] : resources[kind].filter((value) => value !== id) } });
  }

  function resourceGroup(kind: "skills" | "mcpServers", title: string): React.ReactElement {
    const all = data?.resourceCatalog[kind] ?? [];
    const picked = settings?.resources?.[kind] ?? [];
    const items = all.filter(match);
    return <section className="wand-settings-pi-resource-group" aria-label={title} key={kind}>
      <Flex align="center" justify="space-between" gap={12}>
        <Typography.Text strong>{title}</Typography.Text>
        <Typography.Text type="secondary">{settings?.resources ? `${picked.length} / ${all.length}` : `${all.length} 项可选`}</Typography.Text>
      </Flex>
      {!all.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={kind === "skills" ? "尚未发现已安装的 Skill" : "尚未配置 MCP 服务"}/>
        : !items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`没有匹配的${title}`}/> : null}
      <ul className="wand-settings-pi-resource-list">
        {items.map((item) => <li key={item.id} className="wand-settings-pi-resource-item" data-selected={picked.includes(item.id)}>
          <Flex align="center" justify="space-between" gap={12}>
            <Flex vertical style={{ minWidth: 0, flex: 1 }}>
              <Typography.Text strong>{item.name}</Typography.Text>
              <Typography.Text type="secondary" className="wand-settings-pi-resource-description" ellipsis={{ tooltip: item.description }}>{item.description}</Typography.Text>
            </Flex>
            {kind === "skills" && data?.skillLocksAvailable ? <Segmented size="small" className="wand-settings-pi-skill-mode"
              aria-label={`默认 Skill ${item.name}`} value={piSkillMode(settings!, item.id)} disabled={disabled}
              options={MODES.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))}
              onChange={(value) => { void save(piSkillModePatch(settings!, item.id, value as PiSkillMode)); }}/> : <WandSwitch ariaLabel={`默认启用 ${item.name}`} checked={picked.includes(item.id)} disabled={disabled}
              onCheckedChange={(checked) => toggleResource(kind, item.id, checked)}/>}
          </Flex>
        </li>)}
      </ul>
    </section>;
  }

  const removed = settings?.resources
    ? [...new Set([...(settings.resources.skills ?? []), ...(settings.lockedSkills ?? []), ...(settings.resources.mcpServers ?? [])])]
      .filter((id) => !(data?.resourceCatalog.skills ?? []).some((item) => item.id === id)
        && !(data?.resourceCatalog.mcpServers ?? []).some((item) => item.id === id))
    : [];

  return <SettingsSection title="Pi 会话默认"
    description="新建 Pi CLI 会话的起点。改动立即保存，已存在的会话保留自己的设置；会话里改某项也会同步成为这里的默认。"
    action={<WandButton kind="ghost" type="button" disabled={disabled} onClick={() => {
      if (!settings) return;
      void save({ resources: { skills: [], mcpServers: [] }, lockedSkills: [] });
    }}>清空默认资源</WandButton>}>
    <SettingsStatus tone={phase === "failed" ? "error" : phase === "saved" ? "success" : "info"}>{message}</SettingsStatus>
    {data ? <Flex vertical gap={16}>
      <div className="wand-settings-library-toggle-row">
        <div>
          <strong>按提示词自动配置</strong>
          <span>{data.skillLocksAvailable
            ? "发送后自动选择 Skills / MCP 并判断 CodeMode；锁定的 Skill 与手动 MCP 优先。"
            : "发送后自动选择 Skills / MCP；锁定的 Skill 与手动 MCP 优先。"}</span>
        </div>
        <WandSwitch ariaLabel="默认按提示词自动配置" checked={settings?.autoResources === true}
          disabled={disabled || (!data.autoResourcesAvailable && settings?.autoResources !== true)}
          onCheckedChange={(checked) => { void save({ autoResources: checked }); }}/>
      </div>
      {!data.autoResourcesAvailable && settings?.autoResources !== true
        ? <Typography.Text type="secondary">{data.autoResourcesReason}</Typography.Text> : null}
      <Flex align="center" justify="space-between" gap={12} wrap>
        <Flex vertical style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong>CodeMode</Typography.Text>
          <Typography.Text type="secondary">新建会话的 CodeMode 默认；「跟随」表示用 Pi 自身配置，勾选自动配置时可按提示词判断。</Typography.Text>
        </Flex>
        <WandSelect ariaLabel="默认 CodeMode" value={settings?.codemodeOverride ?? "follow"}
          options={CODEMODE_OPTIONS} disabled={disabled}
          onValueChange={(value) => { void save({ codemodeOverride: value === "follow" ? null : value as "off" | "on" }); }}/>
      </Flex>
      <div className="wand-settings-library-toggle-row">
        <div>
          <strong>本地决策</strong>
          <span>允许会话用本机模型判断 Skills / MCP 与 CodeMode；关闭后新建会话不会调用本地决策。</span>
        </div>
        <WandSwitch ariaLabel="默认本地决策" checked={settings?.localDecision !== false} disabled={disabled}
          onCheckedChange={(checked) => { void save({ localDecision: checked }); }}/>
      </div>
      <input className="wand-settings-pi-search" type="search" value={query} aria-label="搜索默认 Skills / MCP"
        placeholder="搜索 Skills / MCP" onChange={(event) => setQuery(event.target.value)}/>
      {data.resourceCatalog.supported ? <>{resourceGroup("skills", "Skills")}{resourceGroup("mcpServers", "MCP")}</>
        : <SettingsStatus tone="warning">{data.resourceCatalog.reason}</SettingsStatus>}
      {removed.length ? <Flex vertical gap={4}>
        <Typography.Text type="danger" strong>默认里已不存在的资源</Typography.Text>
        <Typography.Text type="secondary">这些 Skill / MCP 已被移除或停用，新建会话会因找不到它们而失败；取消后可继续。</Typography.Text>
        <Flex gap={8} wrap>{removed.map((id) => <WandButton key={id} kind="ghost" type="button" disabled={disabled}
          aria-label="移除已失效的默认资源" onClick={() => {
            if (!settings) return;
            const resources = settings.resources ?? { skills: [], mcpServers: [] };
            void save({ resources: { skills: resources.skills.filter((value) => value !== id),
              mcpServers: resources.mcpServers.filter((value) => value !== id) },
            lockedSkills: (settings.lockedSkills ?? []).filter((value) => value !== id) });
          }}><WandIcon name="close" size={14}/>{id.slice(0, 14)}</WandButton>)}</Flex>
      </Flex> : null}
    </Flex> : null}
  </SettingsSection>;
}
