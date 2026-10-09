import { WandButton } from "../ui";
import { Alert, Card, Checkbox, Empty, Flex, List, Typography } from "antd";
import { WandUiBoundary } from "../theme";
import * as React from "react";
import { createPortal } from "react-dom";
import { piSettingsController, type PiSettingsMount } from "./controller";
import { PiAutoResourcesControl } from "./recommender";
import { PiSkillSwitch } from "./skill-switch";
import { piSkillMode, piSkillModePatch } from "../../../pi-session-settings.js";
import { piSettingsRepository } from "./repository";
import { WandIcon, WandSearchField, WandSelect, isWandPopupOwnedBy } from "../ui";
import type { PiResourceItem, PiResourceSelection, PiSessionSettingsPatch, PiSettingsResponse } from "../../../pi-session-settings.js";
import { agentToolDisplayName } from "../../provider-identity.js";

const panelId = (mount: PiSettingsMount): string => `wand-pi-settings-panel-${mount.sessionId}`;
const LOADING_MESSAGE = "正在读取会话功能与 Skills / MCP…";
const CODEMODE_OPTIONS = [
  { value: "follow", label: "跟随 Pi 配置" }, { value: "off", label: "关闭" },
  { value: "on", label: "启用" }, { value: "only", label: "仅 CodeMode" },
];

export function piSettingsScope(data: PiSettingsResponse): string {
  return data.engine === "cli"
    ? "影响当前会话的下一轮，并记为之后新建 Pi CLI 会话的默认；其他已有会话不变。"
    : "仅影响当前 Wand Agent 会话的下一轮；不会改动全局默认或其他会话。";
}

export function panelNotes(data: PiSettingsResponse | null): string[] {
  if (!data) return [];
  if (!data.resourceCatalog) return ["当前服务端尚不支持 Skills / MCP 选择，请更新服务端。"];
  if (!data.resourceCatalog.supported) return [data.resourceCatalog.reason || "此会话不支持 Skills / MCP 选择。"];
  if (!data.settings.resources) return ["旧会话仍沿用 Pi 自动发现；勾选任意项或点击「改为仅选定资源」后，下一轮才停止加载未选项。基础工具不受影响。"];
  return [data.skillLocksAvailable ? "Skills 三档：关 → 开 → 开并锁定。锁定项始终开启，未锁定项由自动配置选择；左滑回「开」解锁。" : "当前服务端不支持 Skill 锁定，请更新服务端。",
    "基础工具保持现有配置，MCP 手选项保留。",
    "选择不是文件系统沙箱；旧会话历史中已读过的技能内容不会被删除。"];
}

function PiSettingsToggle({ mount }: { mount: PiSettingsMount }): React.ReactElement {
  const open = mount.open;
  return <WandButton kind="ghost" type="button" className="btn-circle btn-circle-action composer-pi-settings-toggle"
    data-open={open ? "true" : "false"} aria-expanded={open} aria-controls={panelId(mount)}
    aria-label={open ? "收起会话功能设置" : "会话功能设置：CodeMode / Skills / MCP"}
    title={open ? "收起会话功能设置" : "会话功能设置：CodeMode / Skills / MCP"}
    onClick={() => { piSettingsController.toggle(mount.sessionId); }}>
    <WandIcon name={open ? "close" : "gear"} size={17} strokeWidth={1.9}/>
  </WandButton>;
}

interface PiSettingsLoad { key: string; phase: string; message: string; data: PiSettingsResponse | null; }

export function PiSettingsPanel({ mount }: { mount: PiSettingsMount }): React.ReactElement {
  const [reload, setReload] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const requestKey = `${mount.sessionId}|${mount.open ? "open" : "closed"}|${mount.openRevision ?? 0}|${reload}`;
  const [load, setLoad] = React.useState<PiSettingsLoad>(() => ({ key: requestKey, phase: "loading", message: LOADING_MESSAGE, data: null }));
  if (load.key !== requestKey) {
    setLoad({ key: requestKey, phase: "loading", message: LOADING_MESSAGE, data: null });
    if (query) setQuery("");
  }
  const { data, phase, message } = load.key === requestKey ? load : { data: null, phase: "loading", message: LOADING_MESSAGE };
  const generation = React.useRef(0);
  const activeRequest = React.useRef<AbortController | null>(null);
  const saving = React.useRef(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const codemodeRef = React.useRef<HTMLButtonElement>(null);
  const selectOpen = React.useRef(false);
  const popupClass = `wand-pi-codemode-${mount.sessionId}`;
  function ownsRequest(revision: number, signal: AbortSignal): boolean {
    const current = piSettingsController.getSnapshot().mounts[0];
    return generation.current === revision && !signal.aborted && current?.open === true
      && current.sessionId === mount.sessionId && current.target === mount.target
      && current.openRevision === mount.openRevision;
  }
  React.useEffect(() => piSettingsController.registerFocus(mount, () => {
    const input = searchRef.current;
    if (input && !input.disabled) { input.focus({ preventScroll: true }); return document.activeElement === input; }
    if (codemodeRef.current && !codemodeRef.current.disabled) {
      codemodeRef.current.focus({ preventScroll: true }); return document.activeElement === codemodeRef.current;
    }
    return false;
  }), [mount.sessionId, mount.target]);
  React.useEffect(() => {
    const revision = ++generation.current;
    activeRequest.current?.abort(); saving.current = false;
    if (!mount.open) return;
    const controller = new AbortController(); activeRequest.current = controller;
    piSettingsRepository.load(mount.sessionId, controller.signal).then((result) => {
      if (!ownsRequest(revision, controller.signal)) return;
      setLoad({ key: requestKey, phase: "ready", data: result,
        message: result.resourceCatalog?.supported ? "选择后自动保存，从下一轮生效；不打断当前执行。"
          : result.resourceCatalog?.reason || "请更新服务端以选择 Skills / MCP" });
    }).catch((error: unknown) => {
      if (!ownsRequest(revision, controller.signal)) return;
      setLoad({ key: requestKey, phase: "failed", data: null,
        message: error instanceof Error ? error.message : "读取失败，请重试。" });
    });
    return () => { ++generation.current; controller.abort(); activeRequest.current?.abort(); };
  }, [requestKey, mount.sessionId, mount.open]);
  React.useEffect(() => {
    if (!mount.open || !piSettingsController.hasPendingFocus()) return;
    // Wait until the newly expanded controls can really receive focus, not a hidden transition frame.
    let frame = 0;
    const focus = (): void => {
      if (!piSettingsController.hasPendingFocus()) return;
      if (piSettingsController.focusControl()) piSettingsController.clearPendingFocus();
      else frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [mount.open, phase]);
  React.useEffect(() => {
    if (!mount.open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (panelRef.current?.contains(target) || mount.toggleTarget.contains(target)
        || target?.closest("#input-box") || isWandPopupOwnedBy(target, popupClass)) return;
      piSettingsController.dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || selectOpen.current) return;
      event.preventDefault(); event.stopPropagation(); piSettingsController.dismiss(); mount.returnFocus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [mount.open, mount.returnFocus, mount.toggleTarget, popupClass]);

  async function save(patch: PiSessionSettingsPatch): Promise<boolean> {
    if (!data || saving.current || (patch.resources && !data.resourceCatalog?.supported)
      || ("lockedSkills" in patch && !data.skillLocksAvailable)
      || ("codemodeOverride" in patch && !data.controls?.codemodeOverride)) return false;
    saving.current = true;
    const revision = ++generation.current;
    const controller = new AbortController(); activeRequest.current = controller;
    setLoad((prev) => ({ ...prev, phase: "saving", message: "正在保存选择…" }));
    try {
      const result = await piSettingsRepository.save(mount.sessionId, patch, controller.signal);
      if (!ownsRequest(revision, controller.signal)) return false;
      const resources = patch.resources;
      const confirmed = result.settings?.resources;
      if (resources && (!confirmed || JSON.stringify(confirmed.skills) !== JSON.stringify(resources.skills)
        || JSON.stringify(confirmed.mcpServers) !== JSON.stringify(resources.mcpServers))) {
        throw new Error("服务端未确认本次选择，请重开面板核对实际设置。");
      }
      if ("lockedSkills" in patch && JSON.stringify(result.settings.lockedSkills) !== JSON.stringify(patch.lockedSkills)) {
        throw new Error("服务端未确认 Skill 锁定，请重开面板核对实际设置。");
      }
      if ("autoResources" in patch && (result.settings.autoResources === true) !== patch.autoResources) {
        throw new Error("服务端未确认自动选择设置，请重新读取核对。");
      }
      if ("codemodeOverride" in patch && (result.settings.codemodeOverride ?? null) !== patch.codemodeOverride) {
        throw new Error("服务端未确认 CodeMode 设置，请重新读取核对。");
      }
      setLoad({ key: requestKey, phase: "saved", data: { ...data, settings: result.settings },
        message: "已保存 · 从下一轮生效" });
      mount.onSaved(mount.sessionId, result.settings);
      return true;
    } catch (error) {
      if (!ownsRequest(revision, controller.signal)) return false;
      setLoad((prev) => ({ ...prev, phase: "failed", message: error instanceof Error ? error.message : "保存失败，原选择未改变。" }));
      return false;
    } finally { if (generation.current === revision) saving.current = false; }
  }
  const selection = data?.settings.resources;
  const saveResources = (resources: PiResourceSelection): void => { void save({ resources }); };
  const supported = Boolean(data?.resourceCatalog?.supported);
  const disabled = !supported || phase === "saving" || phase === "loading";
  const needle = query.trim().toLocaleLowerCase();
  function group(kind: "skills" | "mcpServers", title: string): React.ReactElement {
    const all = data?.resourceCatalog?.[kind] ?? [];
    const picked = selection?.[kind] ?? [];
    const locks = kind === "skills" ? data?.settings.lockedSkills ?? [] : [];
    const missing = [...new Set([...picked, ...locks])].filter((id) => !all.some((item) => item.id === id));
    const items = all.filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle));
    const toggle = (item: PiResourceItem, checked: boolean): void => {
      const base = selection ?? { skills: [], mcpServers: [] };
      saveResources({ ...base, [kind]: checked ? [...base[kind], item.id] : base[kind].filter((id) => id !== item.id) });
    };
    return <Card size="small" title={title} extra={<Typography.Text type="secondary">{selection ? `${picked.length} / ${all.length}` : `${all.length} 项可选`}</Typography.Text>} aria-label={title} key={kind}>
      {!all.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={kind === "skills" ? "尚未发现已安装的 Skill" : "尚未配置 MCP 服务（不会自动安装或连接）"}/> : !items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`没有匹配的${title}`}/> : null}
      <List size="small">
        {items.map((item) => <List.Item className="wand-pi-resource-item" key={item.id} data-selected={picked.includes(item.id)}>
          {kind === "skills" && data?.skillLocksAvailable ? <Flex align="center" justify="space-between" gap={12} style={{ width: "100%" }}>
            <Flex vertical style={{ minWidth: 0 }}><Typography.Text strong>{item.name}</Typography.Text><Typography.Text type="secondary">{item.description}</Typography.Text></Flex>
            <PiSkillSwitch name={item.name} mode={piSkillMode(data.settings, item.id)} disabled={disabled}
              onModeChange={(mode) => save(piSkillModePatch(data.settings, item.id, mode))}/>
          </Flex> : <Checkbox aria-label={`启用 ${item.name}`} checked={picked.includes(item.id)} disabled={disabled} onChange={(event) => toggle(item, event.target.checked)}>
            <Flex vertical><Typography.Text strong>{item.name}</Typography.Text><Typography.Text type="secondary">{item.description}</Typography.Text></Flex>
          </Checkbox>}
        </List.Item>)}
        {missing.map((id) => <List.Item key={id}>
          <Flex align="center" justify="space-between" gap={12} style={{ width: "100%" }}>
            <Flex vertical><Typography.Text type="danger" strong>资源已移除</Typography.Text><Typography.Text type="secondary">不会回退加载其他资源；取消此项后可重新选择。</Typography.Text></Flex>
            <WandButton kind="ghost" disabled={disabled} aria-label="取消已移除资源" onClick={() => {
              void save({ resources: { ...(selection ?? { skills: [], mcpServers: [] }), [kind]: picked.filter((item) => item !== id) },
                ...(kind === "skills" && data?.skillLocksAvailable ? { lockedSkills: locks.filter((item) => item !== id) } : {}) });
            }}>取消</WandButton>
          </Flex>
        </List.Item>)}
      </List>
    </Card>;
  }
  return <WandUiBoundary><div className={`wand-pi-settings wand-pi-settings-inner${mount.open ? " is-open" : ""}`} hidden={!mount.open} aria-hidden={!mount.open} inert={!mount.open}
    style={{ pointerEvents: "auto" }} id={panelId(mount)} ref={panelRef} role="region" aria-labelledby={`${panelId(mount)}-title`} data-wand-ui-root="">
    <Card size="small" title={<span id={`${panelId(mount)}-title`}>{data ? agentToolDisplayName("pi", data.engine) : "会话"} 功能设置</span>}
      extra={<WandButton kind="ghost" type="button" aria-label="关闭会话功能设置" onClick={() => { piSettingsController.dismiss(); mount.returnFocus(); }}><WandIcon name="close" size={15}/></WandButton>}>
      <Flex vertical gap={12}>
        {data && <Typography.Text type="secondary" className="wand-pi-settings-scope">{piSettingsScope(data)}</Typography.Text>}
        <Alert type={phase === "failed" ? "error" : phase === "saved" ? "success" : "info"} title={message}
          className="wand-pi-settings-feedback" role="status" aria-live="polite" data-phase={phase}
          action={phase === "failed" && !data ? <WandButton kind="ghost" type="button" onClick={() => setReload((n) => n + 1)}>重试</WandButton> : undefined}/>
        <WandSearchField value={query} onValueChange={setQuery} label="搜索 Skills / MCP" inputRef={searchRef} disabled={!supported}/>
        <Flex vertical gap={16} style={{ maxHeight: "min(390px, 45vh)", overflow: "auto", overflowAnchor: "none" }}>
          {supported && data && <PiAutoResourcesControl data={data} disabled={disabled} save={save}/>}
          <Flex align="center" justify="space-between" gap={12} wrap>
            <Flex vertical style={{ minWidth: 0, flex: 1 }}><Typography.Text strong>CodeMode</Typography.Text><Typography.Text type="secondary">{data && !data.controls?.codemodeOverride
              ? "当前服务端不支持本会话 CodeMode 设置，请更新服务端。" : "启用后可在脚本中组合工具调用；仅 CodeMode 将工具声明收进脚本入口。"}</Typography.Text></Flex>
            <WandSelect ariaLabel="CodeMode 模式" value={data?.settings.codemodeOverride ?? "follow"}
              options={CODEMODE_OPTIONS.map((option) => option.value === "follow" && data?.settings.autoResources && data.autoCodemodeAvailable ? { ...option, label: "按提示词自动判断" } : option)}
              triggerRef={codemodeRef} contentClassName={popupClass} popupOwner={popupClass}
              disabled={!data?.controls?.codemodeOverride || phase === "loading" || phase === "saving"}
              onOpenChange={(open) => { selectOpen.current = open; }}
              onValueChange={(value) => { void save({ codemodeOverride: value === "follow" ? null : value as "off" | "on" | "only" }); }}/>
          </Flex>
          {!selection && supported && <Flex align="center" justify="space-between" gap={12} wrap>
            <Typography.Text type="secondary">旧会话仍沿用 Pi 自动发现</Typography.Text>
            <WandButton kind="ghost" type="button" disabled={disabled} onClick={() => { saveResources({ skills: [], mcpServers: [] }); }}>改为仅选定资源</WandButton>
          </Flex>}
          {supported && <>{group("skills", "Skills")}{group("mcpServers", "MCP")}</>}
          {supported && data?.resourceCatalog?.reason && <Typography.Text type="secondary">{data.resourceCatalog.reason}</Typography.Text>}
          {panelNotes(data).map((note) => <Typography.Text type="secondary" key={note}>{note}</Typography.Text>)}
        </Flex>
      </Flex>
    </Card>
  </div></WandUiBoundary>;
}

export function PiSettingsHost(): React.ReactElement[] {
  const snapshot = React.useSyncExternalStore(piSettingsController.subscribe, piSettingsController.getSnapshot, piSettingsController.getSnapshot);
  return snapshot.mounts.flatMap((mount) => [
    createPortal(<PiSettingsToggle key={`${mount.sessionId}-toggle`} mount={mount}/>, mount.toggleTarget, `${mount.key}-toggle`),
    createPortal(<PiSettingsPanel key={mount.sessionId} mount={mount}/>, mount.target, mount.key),
  ]);
}
