import * as React from "react";
import { Radio } from "antd";
import { WAND_PALETTES } from "../theme-palettes";
import { setWandTheme, wandThemeStore } from "../theme-preference";
import { SettingsSection, SettingsStatus } from "./fields";

export function ThemePicker() {
  const selected = React.useSyncExternalStore(wandThemeStore.subscribe, wandThemeStore.getSnapshot, wandThemeStore.getServerSnapshot);
  const [storageDenied, setStorageDenied] = React.useState(false);
  return <SettingsSection title="主题配色" description="立即应用并自动保存在当前浏览器；不影响其他设备。">
    <Radio.Group name="wand-theme" aria-label="主题配色" value={selected} className="wand-theme-picker"
      onChange={event => setStorageDenied(!setWandTheme(event.target.value))}>
      {WAND_PALETTES.map(p => <Radio key={p.id} value={p.id} className="wand-theme-choice">
        <span className="wand-theme-preview" aria-hidden="true" style={{ background: p.background, borderColor: p.border }}>
          <span className="wand-theme-preview-sidebar" style={{ background: p.sidebar }} />
          <span className="wand-theme-preview-lines" style={{ color: p.secondary }}><i /><i /><i /></span>
          <span className="wand-theme-preview-selection" style={{ background: p.primary }} />
        </span>
        <span className="wand-theme-choice-label">{p.name}<span className="wand-theme-choice-status" aria-hidden="true">{selected === p.id ? "已选" : ""}</span></span>
      </Radio>)}
    </Radio.Group>
    {storageDenied && <SettingsStatus tone="warning">配色已应用。浏览器未允许保存，刷新后可能恢复原配色。</SettingsStatus>}
  </SettingsSection>;
}
