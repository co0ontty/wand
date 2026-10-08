import * as React from "react";
import { useState } from "react";
import { SettingsActionButton, SettingsField, SettingsSection, SettingsStatus, SettingsTextInput } from "./fields";
import { failureMessage } from "../errors";
import type { SettingsTabProps } from "./tabs";

export function OpenRouterSettingsPanel({ snapshot, repository, setSnapshot }: Pick<SettingsTabProps,
  "snapshot" | "repository" | "setSnapshot">): React.ReactElement {
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const status = snapshot.openRouter;

  async function run(action: "save" | "refresh" | "clear"): Promise<void> {
    if (pending) return;
    setPending(action);
    setMessage("");
    try {
      const result = await repository.execute(action === "save"
        ? { type: "openrouter.save", apiKey }
        : action === "clear" ? { type: "openrouter.clear" } : { type: "openrouter.refresh" });
      setSnapshot((current) => current ? { ...current, openRouter: result, models: result.models ?? current.models } : current);
      if (action === "save" || action === "clear") setApiKey("");
      setFailed(!!result.lastError);
      setMessage(result.lastError
        ? `${action === "save" ? "Key 已保存。" : ""}${result.lastError} 当前分组包含 ${result.modelCount} 个已验证模型。`
        : action === "clear" ? "Key 已移除，免费分组已清空。"
          : `验证完成：${result.modelCount} 个可用，${result.rejectedCount ?? 0} 个已移除。`);
    } catch (cause) {
      setFailed(true);
      setMessage(failureMessage(cause, "OpenRouter 配置失败，请重试。"));
    } finally { setPending(""); }
  }

  return (
    <SettingsSection title="OpenRouter 免费模型"
      description="在 Pi 中选择「免费分组」即可，由系统自动分配已验证的免费语言模型，无需指定具体模型。填写 Key 后立即同步，之后每 6 小时自动更新；每次调用前检查价格，已收费的自动换用其他免费模型。">
      <SettingsField label="OpenRouter Key" htmlFor="settings-openrouter-key"
        hint={status?.configured ? "Key 已保存；填写新 Key 可以替换。密钥不会回显。" : "在 OpenRouter 创建 API Key 后填写。"}>
        <SettingsTextInput id="settings-openrouter-key" type="password" autoComplete="new-password"
          value={apiKey} onChange={setApiKey} disabled={!!pending}
          placeholder={status?.configured ? "填写新 Key 以替换" : "sk-or-v1-…"} />
      </SettingsField>
      <div className="wand-settings-library-button-row">
        <SettingsActionButton kind="secondary" pending={pending === "save"}
          disabled={!!pending || !apiKey.trim()} onClick={() => void run("save")}>保存并同步</SettingsActionButton>
        <SettingsActionButton kind="ghost" pending={pending === "refresh"}
          disabled={!!pending || !status?.configured} onClick={() => void run("refresh")}>立即同步</SettingsActionButton>
        {status?.configured ? <SettingsActionButton kind="ghost" pending={pending === "clear"}
          disabled={!!pending} onClick={() => void run("clear")}>移除 Key</SettingsActionButton> : null}
      </div>
      <SettingsStatus tone={message ? failed ? "error" : "success" : status?.lastError ? "error" : "info"}>
        {(pending ? "正在同步价格并验证新增模型，请稍候…" : message) || status?.lastError || (status?.configured
          ? `免费分组 · ${status.modelCount} 个已验证模型 · ${status.rejectedCount ?? 0} 个已移除${status.lastSyncedAt ? ` · 上次同步 ${new Date(status.lastSyncedAt).toLocaleString()}` : " · 尚未同步成功"}`
          : "保存 Key 后，可在 Pi 的模型选择器中选择「免费分组」。")}
      </SettingsStatus>
    </SettingsSection>
  );
}
