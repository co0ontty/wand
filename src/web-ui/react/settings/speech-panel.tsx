import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Progress } from "antd";
import type { SpeechStatus } from "../../../speech-types.js";
import type { LocalModelsStatus } from "../../../local-model-types.js";
import { installLocalSpeech, localSpeechSupported, readSpeechMode, saveSpeechMode, type SpeechMode } from "../speech/repository";
import { jsonBody, requestJson } from "../http-adapter";
import { SettingsActionButton, SettingsField, SettingsSection, SettingsSelect, SettingsStatus, SettingsToggle } from "./fields";

export function SpeechSettingsTab({ admin }: { admin: boolean }) {
  const [mode, setMode] = useState<SpeechMode>(readSpeechMode);
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [models, setModels] = useState<LocalModelsStatus | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState(false);
  const request = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const operation = models?.speech.operation;
  const working = !!operation && !["completed", "failed", "cancelled"].includes(operation.phase);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let timer: number;
    async function refresh() {
      const started = generation.current;
      try {
        const [nextStatus, nextModels] = await Promise.all([
          requestJson<SpeechStatus>("/api/speech/status", { signal: abort.signal }),
          requestJson<LocalModelsStatus>("/api/local-models/status", { signal: abort.signal }),
        ]);
        if (abort.signal.aborted) return;
        // A poll begun before a user action cannot overwrite its response.
        if (!request.current && started === generation.current) { setStatus(nextStatus); setModels(nextModels); setLoadError(""); }
      } catch (cause) {
        if (!abort.signal.aborted && !request.current && started === generation.current) setLoadError(cause instanceof Error ? cause.message : "无法读取语音状态。");
      }
      if (!abort.signal.aborted) timer = window.setTimeout(() => void refresh(), 1500);
    }
    void refresh();
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, []);
  async function act(perform: () => Promise<LocalModelsStatus | void>) {
    if (request.current) return;
    request.current = true; generation.current += 1; setPending(true); setError("");
    try { const next = await perform(); if (mounted.current && next) setModels(next); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { request.current = false; if (mounted.current) setPending(false); }
  }
  const speech = models?.speech;
  return <>
    <SettingsSection title="服务端语音输入" description="音频仅发送到当前 Wand 服务器，离线识别，不调用第三方云服务。">
      <SettingsStatus tone={!speech ? "info" : speech.supported ? "success" : "warning"}>
        {!speech ? "正在检查本机支持情况…" : speech.supported ? "当前机器支持服务端语音识别。" : `当前机器暂不支持：${speech.supportReason || speech.reason || "运行环境不可用。"}`}
      </SettingsStatus>
      <SettingsToggle label="启用服务端语音输入" checked={speech?.enabled === true || (working && operation?.action === "activate")}
        disabled={!admin || !speech || pending || (!speech.supported && !speech.enabled) || (speech.busy && !working)}
        description={working ? "准备中；关闭开关可取消。" : "首次启用会自动下载模型并准备运行环境，完成后即可使用。"}
        onCheckedChange={(enabled) => void act(() => requestJson<LocalModelsStatus>("/api/local-models/speech/settings", jsonBody({ enabled }, "PATCH")))} />
      {working ? <SettingsStatus>{operation.message}</SettingsStatus> : operation?.phase === "failed" ? <SettingsStatus tone="error">{operation.error || operation.message} 再次开启即可重试。</SettingsStatus>
        : speech?.enabled ? <SettingsStatus tone={status?.ready ? "success" : "warning"}>{status?.ready ? "已启用，按住麦克风说话，松手转写；最长 60 秒。" : status?.reason || "正在确认识别状态…"}</SettingsStatus> : null}
      {working && operation?.phase === "downloading" && operation.total ? <Progress percent={Math.floor(operation.received / operation.total * 100)} aria-label="语音模型下载进度" /> : null}
      {!admin ? <SettingsStatus>启用或关闭需要服务器管理权限。</SettingsStatus> : null}
      {error || loadError ? <SettingsStatus tone="error">{error || loadError}</SettingsStatus> : null}
    </SettingsSection>
    <SettingsSection title="此设备的识别方式" description="只影响当前设备，其他客户端保持各自的选择。">
      <SettingsField label="识别方式" htmlFor="settings-speech-mode">
        <SettingsSelect id="settings-speech-mode" ariaLabel="识别方式" value={mode} options={[
          { value: "server", label: "服务端识别" }, { value: "local", label: "客户端本地识别" },
        ]} onChange={(value) => { const next = value as SpeechMode; saveSpeechMode(next); setMode(next); }} />
      </SettingsField>
      {mode === "local" ? <>
        <SettingsStatus tone={localSpeechSupported() ? "info" : "warning"}>
          {localSpeechSupported() ? "使用浏览器端侧语言包，不上传音频。" : "当前浏览器不支持端侧识别，请使用服务端识别或原生客户端。"}
        </SettingsStatus>
        {localSpeechSupported() ? <SettingsActionButton kind="secondary" pending={pending} onClick={() => act(installLocalSpeech)}>下载浏览器语言包</SettingsActionButton> : null}
      </> : null}
    </SettingsSection>
  </>;
}
