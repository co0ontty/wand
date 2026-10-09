import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Space } from "antd";
import { SpeechModelSetupControls } from "./local-models-panel";
import type { SpeechSettings, SpeechStatus } from "../../../speech-types.js";
import { installLocalSpeech, localSpeechSupported, readSpeechMode, saveSpeechMode, type SpeechMode } from "../speech/repository";
import { jsonBody, requestJson } from "../http-adapter";
import { SettingsActionButton, SettingsField, SettingsGrid, SettingsSaveBar, SettingsSection, SettingsSelect, SettingsStatus, SettingsTextInput, SettingsToggle } from "./fields";

export function SpeechSettingsTab({ admin }: { admin: boolean }) {
  const [mode, setMode] = useState<SpeechMode>(readSpeechMode);
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [draft, setDraft] = useState<SpeechSettings | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [saved, setSaved] = useState(false);
  const refreshResources = useCallback(() => {
    void requestJson<SpeechStatus>("/api/speech/status").then(setStatus)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "读取语音状态失败。"));
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void requestJson<SpeechStatus>("/api/speech/status", { signal: abort.signal }).then((next) => { setStatus(next); setDraft(next.settings); })
      .catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取语音设置。"); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (status?.download?.phase !== "downloading") return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void requestJson<SpeechStatus>("/api/speech/status", { signal: abort.signal }).then(setStatus)
        .catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "读取下载进度失败。"); });
    }, 2000);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [status]);
  async function action(key: string, perform: () => Promise<SpeechStatus | void>) {
    setPending(key); setError(""); setSaved(false);
    try { const next = await perform(); if (next) setStatus(next); setSaved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { setPending(""); }
  }
  function edit(patch: Partial<SpeechSettings>) { if (draft) setDraft({ ...draft, ...patch }); setSaved(false); }
  const selected = status?.models.find((model) => model.id === draft?.model);
  return <>
    <SettingsSection title="此设备的识别方式" description="只影响当前设备，其他客户端保持各自的选择。按住麦克风录音，松手转写，上滑取消；结果填入输入草稿，由你核对后发送。">
      <SettingsField label="识别方式" htmlFor="settings-speech-mode">
        <SettingsSelect id="settings-speech-mode" ariaLabel="识别方式" value={mode} options={[
          { value: "server", label: "服务端识别" }, { value: "local", label: "客户端本地识别" },
        ]} onChange={(value) => { const next = value as SpeechMode; saveSpeechMode(next); setMode(next); }} />
      </SettingsField>
      <SettingsStatus tone={mode === "server" ? status?.ready ? "success" : "warning" : localSpeechSupported() ? "info" : "warning"}>
        {mode === "server" ? status?.ready ? "音频发送到当前连接的 Wand 主机，由本机 whisper.cpp 模型转写；最长 60 秒，不调用第三方云端语音识别。" : status?.reason || "正在检查服务端…"
          : localSpeechSupported() ? "使用浏览器端侧语言包，音频不上传。语言包不可用时会报错，不会自动切换到云端识别。" : "当前浏览器不支持端侧识别，不会自动切换识别方式；请手动选择服务端识别或使用原生客户端。"}
      </SettingsStatus>
      {mode === "local" && localSpeechSupported() ? <SettingsActionButton kind="secondary" pending={pending === "local"} settled={saved ? "success" : error ? "error" : null}
        onClick={() => action("local", installLocalSpeech)}>下载浏览器语言包</SettingsActionButton> : null}
    </SettingsSection>
    <SettingsSection title="服务端语音模型" description={status ? `当前服务器：${status.runtime.platform} / ${status.runtime.arch} · ${status.runtime.backend.toUpperCase()} 运行时${status.runtime.available ? "已安装" : "未安装"}` : "读取当前服务器配置"}
      action={<SettingsActionButton kind="secondary" pending={pending === "refresh"} onClick={() => action("refresh", () => requestJson<SpeechStatus>("/api/speech/status"))}>刷新状态</SettingsActionButton>}>
      {status && draft ? <>
        <SettingsToggle label="启用服务端语音识别" checked={draft.enabled} disabled={!admin || !!pending}
          description="只在本机服务器推理，不调用付费或第三方云识别。" onCheckedChange={(enabled) => edit({ enabled })} />
        <SettingsGrid>
          <SettingsField label="多语言模型" htmlFor="settings-speech-model">
            <SettingsSelect id="settings-speech-model" ariaLabel="服务端语音模型" value={draft.model} disabled={!admin || !!pending}
              options={status.models.map((model) => ({ value: model.id, label: `${model.label} · ${Math.round(model.size / 1024 / 1024)} MiB${model.downloaded ? " · 已下载" : ""}` }))}
              onChange={(model) => edit({ model })} />
          </SettingsField>
          <SettingsField label="运行设备" htmlFor="settings-speech-acceleration">
            <SettingsSelect id="settings-speech-acceleration" ariaLabel="语音运行设备" value={draft.acceleration} disabled={!admin || !!pending}
              options={[{ value: "auto", label: "自动（GPU 不可用回退 CPU）" }, { value: "cpu", label: "CPU（无需 GPU）" }, { value: "gpu", label: "GPU（Metal / CUDA）" }]}
              onChange={(acceleration) => edit({ acceleration: acceleration as SpeechSettings["acceleration"] })} />
          </SettingsField>
          <SettingsField label="识别语言" htmlFor="settings-speech-language">
            <SettingsSelect id="settings-speech-language" ariaLabel="识别语言" value={draft.language} disabled={!admin || !!pending}
              options={[{ value: "auto", label: "自动检测" }, { value: "zh", label: "中文" }, { value: "en", label: "English" }]}
              onChange={(language) => edit({ language: language as SpeechSettings["language"] })} />
          </SettingsField>
          <SettingsField label="CPU 线程" htmlFor="settings-speech-threads" hint="1–16；低配置服务器建议 1–4。">
            <SettingsTextInput id="settings-speech-threads" type="number" min={1} max={16} value={draft.threads} disabled={!admin || !!pending}
              onChange={(threads) => edit({ threads: Number(threads) })} />
          </SettingsField>
        </SettingsGrid>
        <Space wrap>
          <span>{selected?.description}</span>
        </Space>
        <SpeechModelSetupControls admin={admin} model={draft.model} downloaded={selected?.downloaded ?? false} size={selected?.size ?? 0} onResourcesChanged={refreshResources}/>
        {status.download?.error ? <SettingsStatus tone="error">{status.download.error}</SettingsStatus> : null}
        {!status.runtime.available ? <SettingsStatus tone="warning">先下载模型，再点击「初始化运行时与模型」。需要服务器具备 Git、CMake 与 C++ 工具链；普通安装/构建不会自动下载。</SettingsStatus> : null}
        {admin ? <SettingsSaveBar label="保存服务端语音设置" pending={pending === "save"} disabled={!!pending}
          onSave={() => void action("save", async () => { const next = await requestJson<SpeechStatus>("/api/speech/settings", jsonBody(draft, "PATCH")); setDraft(next.settings); return next; })}
          tone={error ? "error" : saved ? "success" : "info"} status={error || (saved ? "操作已完成。" : "设置对连接此服务器的客户端生效。模型与运行设备不会替换客户端本地模型。")}/> : <SettingsStatus>启用、配置与下载需要服务器管理权限；可在完整 Web 设置中管理。</SettingsStatus>}
      </> : null}
      {error && (!status || !admin) ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
    </SettingsSection>
  </>;
}
