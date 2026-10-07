import * as React from "react";
import { Flex, Typography } from "antd";
import { WandSwitch } from "../ui";
import type { PiSessionSettingsPatch, PiSettingsResponse } from "../../../pi-session-settings.js";

/** Settings opt-in only. Prompt matching is owned by the submitted server runner. */
export function PiAutoResourcesControl({ data, disabled, save }: {
  data: PiSettingsResponse; disabled: boolean; save(patch: PiSessionSettingsPatch): Promise<boolean>;
}): React.ReactElement {
  const enabled = data.settings.autoResources === true;
  const available = data.autoResourcesAvailable === true;
  const reason = data.autoResourcesReason || "请更新服务端或启用本地决策后使用。";
  return <Flex vertical gap={8} component="section" aria-label="按提示词自动配置">
    <Flex justify="space-between" align="center" gap={12}><Flex vertical><Typography.Text strong>按提示词自动配置</Typography.Text>
      <Typography.Text type="secondary">{data.skillLocksAvailable ? "锁定的 Skills 保持开/关，其余自动选择；MCP 手选与 CodeMode 手动覆盖优先。"
        : data.autoCodemodeAvailable ? "发送后选择 Skills / MCP 并判断 CodeMode；手选与手动覆盖优先。"
          : "发送后选择 Skills / MCP，保留手选项。"}</Typography.Text></Flex>
      <WandSwitch ariaLabel="按提示词自动配置" checked={enabled}
        disabled={disabled || (!available && !enabled)} onCheckedChange={(checked) => { void save({ autoResources: checked }); }}/>
    </Flex>
    <Typography.Text type="secondary">{available ? "仅本会话 · 本轮配置显示在小字消息中；失败沿用原配置，MCP 目前只按明确点名选择。" : reason}</Typography.Text>
    {available && !data.autoCodemodeAvailable && <Typography.Text type="secondary">当前服务端仅自动选择 Skills / MCP；CodeMode 自动判断需更新服务端。</Typography.Text>}
  </Flex>;
}
