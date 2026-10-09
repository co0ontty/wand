import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Progress, Space, Typography } from "antd";
import type { LocalModelKind, LocalModelsStatus, LocalModelStatus } from "../../../local-model-types.js";
import { jsonBody, requestJson } from "../http-adapter";
import { SettingsActionButton, SettingsField, SettingsSection, SettingsSelect, SettingsStatus, SettingsToggle } from "./fields";

function useLocalModels() {
  const [status, setStatus] = useState<LocalModelsStatus | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await requestJson<LocalModelsStatus>("/api/local-models/status", { signal });
      if (!next.laya || !next.speech) throw new Error("服务端尚未提供本地模型管理，请先更新 Wand。");
      setStatus(next); setError("");
    }
    catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "无法读取本地模型状态。"); }
  }, []);
  useEffect(() => { const abort = new AbortController(); void refresh(abort.signal); return () => abort.abort(); }, [refresh]);
  useEffect(() => {
    if (![status?.laya, status?.speech].some(value => value?.operation && !["completed", "failed", "cancelled"].includes(value.operation.phase))) return;
    const abort = new AbortController(), timer = window.setTimeout(() => void refresh(abort.signal), 1500);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [status, refresh]);
  return { status, setStatus, error, setError, refresh };
}

function ModelInstallActions({ value, admin, model, backend, downloaded, onStatus, onError }: {
  value: LocalModelStatus; admin: boolean; model?: string; backend?: string; downloaded?: boolean;
  onStatus(value: LocalModelsStatus): void; onError(message: string): void;
}) {
  const [pending, setPending] = useState("");
  const operation = value.operation;
  const working = !!operation && !["completed", "failed", "cancelled"].includes(operation.phase);
  const completeModel = downloaded ?? value.downloaded;
  async function act(action: "download" | "initialize" | "cancel") {
    setPending(action); onError("");
    try {
      const payload = action === "cancel" ? {} : { ...(model ? { model } : {}), ...(backend && value.kind === "speech" ? { backend } : {}) };
      const next = await requestJson<LocalModelsStatus>(`/api/local-models/${value.kind}/${action}`, jsonBody(payload));
      onStatus(next);
    } catch (cause) { onError(cause instanceof Error ? cause.message : "模型操作失败，请重试。"); }
    finally { setPending(""); }
  }
  return <>
    <Space wrap>
      <SettingsActionButton kind="secondary" pending={pending === "download" || (working && operation.action === "download")}
        disabled={!admin || !value.supported || !!pending || (value.busy && !working) || working || completeModel}
        pendingLabel="下载中…" successLabel="已下载" errorLabel="下载失败"
        settled={operation?.action === "download" && operation.phase === "completed" ? "success" : operation?.action === "download" && operation.phase === "failed" ? "error" : null}
        onClick={() => act("download")}>
        {completeModel ? "模型已下载" : operation?.action === "download" && operation.phase === "failed" ? "重试下载" : `下载模型（${Math.round(value.modelSize / 1024 / 1024)} MiB）`}
      </SettingsActionButton>
      <SettingsActionButton kind="primary" pending={pending === "initialize" || (working && operation.action === "initialize")}
        disabled={!admin || !value.supported || !completeModel || !!pending || (value.busy && !working) || working}
        pendingLabel="初始化中…" successLabel="已初始化" errorLabel="初始化失败"
        settled={operation?.action === "initialize" && operation.phase === "completed" ? "success" : operation?.action === "initialize" && operation.phase === "failed" ? "error" : null}
        onClick={() => act("initialize")}>
        {operation?.action === "initialize" && operation.phase === "failed" ? "重试初始化" : "初始化运行时与模型"}
      </SettingsActionButton>
      {working && admin ? <SettingsActionButton kind="secondary" pending={pending === "cancel"} onClick={() => act("cancel")}>取消安装任务</SettingsActionButton> : null}
    </Space>
    {operation ? <SettingsStatus tone={operation.phase === "failed" ? "error" : operation.phase === "completed" ? "success" : "info"}>
      {operation.message}
    </SettingsStatus> : null}
    {operation?.phase === "downloading" && operation.total ? <Progress percent={Math.floor(operation.received / operation.total * 100)} aria-label={`${value.label}下载进度`}/> : null}
    {!admin ? <SettingsStatus>下载、初始化、取消和启用需要管理员权限；当前连接可查看实际状态。</SettingsStatus> : null}
  </>;
}

export function SpeechModelSetupControls({ admin, model, downloaded, size, onResourcesChanged }: {
  admin: boolean; model: string; downloaded: boolean; size: number; onResourcesChanged(): void;
}) {
  const state = useLocalModels();
  const [backend, setBackend] = useState("auto");
  const operation = state.status?.speech.operation;
  useEffect(() => { if (operation?.phase === "completed") onResourcesChanged(); }, [operation?.id, operation?.phase, onResourcesChanged]);
  return <>
    <SettingsField label="运行时适配" hint="自动：Mac 使用 Metal，其他主机使用 CPU；CUDA 需服务器已有 Toolkit。">
      <SettingsSelect id="settings-speech-runtime-backend" ariaLabel="语音运行时适配" value={backend} disabled={!admin || state.status?.speech.busy}
        options={[{ value: "auto", label: "自动（按服务器平台）" }, { value: "cpu", label: "CPU（无需 GPU）" }, { value: "metal", label: "Mac Metal" }, { value: "cuda", label: "NVIDIA CUDA" }]} onChange={setBackend}/>
    </SettingsField>
    {state.status ? <ModelInstallActions value={{ ...state.status.speech, modelSize: size }} admin={admin} model={model} downloaded={downloaded} backend={backend}
      onStatus={state.setStatus} onError={state.setError}/> : null}
    {state.error ? <SettingsStatus tone="error">{state.error}</SettingsStatus> : null}
  </>;
}

export function LocalModelsSettingsTab({ admin }: { admin: boolean }) {
  const state = useLocalModels();
  const [saving, setSaving] = useState(false);
  async function enabled(value: boolean) {
    setSaving(true); state.setError("");
    try { state.setStatus(await requestJson<LocalModelsStatus>("/api/local-models/laya/settings", jsonBody({ enabled: value }, "PATCH"))); }
    catch (cause) { state.setError(cause instanceof Error ? cause.message : "保存失败。"); }
    finally { setSaving(false); }
  }
  const laya = state.status?.laya;
  return <>
    <SettingsSection title="LAYA 本地决策模型" description="用于有界选择、评分与是非判断，不是聊天模型，也不代替授权。当前仅支持 Apple Silicon macOS / Metal。"
      action={<SettingsActionButton kind="secondary" onClick={() => state.refresh()}>刷新状态</SettingsActionButton>}>
      {laya ? <>
        <Typography.Text type="secondary">{laya.model} · {Math.round(laya.modelSize / 1024 / 1024)} MiB · {laya.downloaded ? "模型校验通过" : "模型未就绪"} · {laya.runtimeAvailable ? "已有运行时" : "运行时未安装"}</Typography.Text>
        <SettingsToggle label="启用 LAYA 本地决策" checked={laya.enabled} disabled={!admin || !laya.supported || laya.busy || saving || !laya.downloaded || !laya.runtimeAvailable}
          description="下载与初始化不会自动启用；也不会改变会话的工具、费用、技能或派工权限。" onCheckedChange={value => void enabled(value)}/>
        <ModelInstallActions value={laya} admin={admin} onStatus={state.setStatus} onError={state.setError}/>
        {laya.reason ? <SettingsStatus tone="warning">{laya.reason}</SettingsStatus> : null}
        <SettingsStatus tone="warning">LAYA 判断质量仍为实验性，高概率不代表正确。不得用它自动审批权限、删除数据或发布。</SettingsStatus>
      </> : <SettingsStatus>正在检查模型和运行时…</SettingsStatus>}
    </SettingsSection>
    <SettingsSection title="语音模型下载与初始化" description="请在「语音输入」中选择 Tiny / Base / Small，再下载和初始化。Mac 默认 Metal，其他服务器默认 CPU；CUDA 要求已安装工具链。">
      {state.status ? <>
        <Typography.Text type="secondary">Whisper {state.status.speech.model} · {state.status.speech.downloaded ? "模型校验通过" : "未下载"} · {state.status.speech.runtimeAvailable ? "运行时已安装" : "运行时未安装"}</Typography.Text>
        <ModelInstallActions value={state.status.speech} admin={admin} model={state.status.speech.model}
          onStatus={state.setStatus} onError={state.setError}/>
      </> : null}
      <SettingsStatus>只安装独立模型组件，不覆盖已有 Python 环境，不中断活动识别/决策，不重启 Wand 服务。</SettingsStatus>
    </SettingsSection>
    {state.error ? <SettingsStatus tone="error">{state.error}</SettingsStatus> : null}
  </>;
}
