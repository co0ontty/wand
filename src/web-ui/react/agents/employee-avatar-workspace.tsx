import * as React from "react";
import { PlushAvatar, retryPlushAvatarRuntime } from "../avatars/plush-avatar.js";
import type { PlushFallbackReason } from "../avatars/runtime-contract.js";
import { PixelCat, shrinkAvatarImage } from "../ai-teams/avatar.js";
import { WandButton, WandIconButton } from "../ui/button.js";
import { WandIcon } from "../ui/icons.js";
import { useReducedMotion } from "../ui/motion-tokens.js";
import { fixedEmployeeAvatar } from "../../../fixed-employee-avatar.js";
import { SILICON_EMPLOYEE_AVATAR_MAX_CHARS } from "../../../ai-team-types.js";
import {
  PLUSH_SHAPES, PLUSH_COLORS, PLUSH_GLASSES, PLUSH_HATS,
  defaultPlushAvatar, encodePlushAvatar, parsePlushAvatar, resolveEmployeeAvatar,
  type PlushAvatarConfig,
} from "../../../plush-avatar.js";

export interface EmployeeAvatarWorkspaceProps {
  employee: { id: string; name: string; avatar?: string; systemKey?: string };
  /** External saving/read-only state; uploading is reported separately via onBusyChange. */
  disabled: boolean;
  /** Updates the employee page's local draft. The page owns saving and cancelling. */
  onChange(avatar: string): void;
  onBusyChange?(busy: boolean): void;
  onClose?(): void;
}

type RendererState = "loading" | "webgl" | "fallback";

function WorkspaceFace({ employee, size, speaking = false, interactive = false, onRendererChange }: {
  employee: EmployeeAvatarWorkspaceProps["employee"];
  size: number;
  speaking?: boolean;
  interactive?: boolean;
  onRendererChange?(renderer: RendererState, reason?: PlushFallbackReason): void;
}) {
  const plush = resolveEmployeeAvatar(employee);
  if (plush) return <PlushAvatar config={plush} size={size} speaking={speaking} interactive={interactive} onRendererChange={onRendererChange}/>;
  if (employee.avatar?.startsWith("data:image/")) return <img className="photo" src={employee.avatar} alt="" width={size} height={size}/>;
  return <span className="pixel" style={{ width: size, height: size }}><PixelCat coat={Number(employee.avatar?.slice(4))}/></span>;
}

/** One workspace inside the employee page; all changes remain in its unsaved draft. */
export function EmployeeAvatarWorkspace({ employee, disabled, onChange, onBusyChange, onClose }: EmployeeAvatarWorkspaceProps): React.ReactElement {
  const reducedMotion = useReducedMotion();
  const fixedAvatar = fixedEmployeeAvatar(employee);
  const identity = { ...employee, avatar: fixedAvatar ?? employee.avatar ?? "" };
  const plush = parsePlushAvatar(identity.avatar) ?? defaultPlushAvatar(employee);
  const plushPreview = resolveEmployeeAvatar(identity) !== null;
  const rendererKey = `${employee.id}:${employee.systemKey ?? ""}:${plushPreview ? "plush" : "legacy"}`;
  const radioId = React.useId();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const epoch = React.useRef(0);
  const busyRef = React.useRef(false);
  const latest = React.useRef({ employee, disabled, fixedAvatar, onChange, onBusyChange });
  latest.current = { employee, disabled, fixedAvatar, onChange, onBusyChange };
  const [processing, setProcessing] = React.useState(false);
  const [error, setError] = React.useState("");
  const [speech, setSpeech] = React.useState(false);
  const [renderStatus, setRenderStatus] = React.useState<{ key: string; renderer: RendererState; reason?: PlushFallbackReason }>({ key: rendererKey, renderer: "loading" });
  const renderer = renderStatus.key === rendererKey ? renderStatus.renderer : "loading";
  const busy = disabled || processing;
  const setBusy = React.useCallback((value: boolean) => {
    setProcessing(value);
    if (busyRef.current !== value) { busyRef.current = value; latest.current.onBusyChange?.(value); }
  }, []);
  const cancelUpload = React.useCallback(() => { ++epoch.current; setBusy(false); }, [setBusy]);
  React.useEffect(() => {
    // Employee switches, cancellation/replacement by the page, or saving invalidate late decodes.
    cancelUpload(); setError(""); setSpeech(false);
  }, [employee.id, employee.systemKey, employee.avatar, disabled, cancelUpload]);
  React.useEffect(() => () => {
    ++epoch.current;
    if (busyRef.current) { busyRef.current = false; latest.current.onBusyChange?.(false); }
  }, []);
  React.useEffect(() => { if (reducedMotion || renderer !== "webgl") setSpeech(false); }, [reducedMotion, renderer]);

  const change = (avatar: string) => {
    if (latest.current.disabled || latest.current.fixedAvatar || busyRef.current) return;
    ++epoch.current; setError(""); setSpeech(false); latest.current.onChange(avatar);
  };
  const close = () => { cancelUpload(); setSpeech(false); onClose?.(); };
  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || latest.current.disabled || latest.current.fixedAvatar || busyRef.current) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
      setError("请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。"); return;
    }
    const generation = ++epoch.current;
    const started = { id: employee.id, systemKey: employee.systemKey, avatar: employee.avatar };
    const eligible = () => epoch.current === generation && !latest.current.disabled && !latest.current.fixedAvatar
      && latest.current.employee.id === started.id && latest.current.employee.systemKey === started.systemKey
      && latest.current.employee.avatar === started.avatar;
    setBusy(true); setError(""); setSpeech(false);
    try {
      const avatar = await shrinkAvatarImage(file, SILICON_EMPLOYEE_AVATAR_MAX_CHARS);
      if (eligible()) { setBusy(false); latest.current.onChange(avatar); }
    } catch (cause: unknown) {
      if (eligible()) setError(cause instanceof Error ? cause.message : "图片处理失败，请重试。");
    } finally { if (epoch.current === generation) setBusy(false); }
  };
  const optionGroup = <F extends "shape" | "glasses" | "hat",>(field: F, label: string, options: ReadonlyArray<{ id: PlushAvatarConfig[F]; label: string }>) =>
    <fieldset className={`option-group ${field}`} disabled={busy}><legend>{label}<span>{options.find(option => option.id === plush[field])?.label}</span></legend>
      <div className="options">{options.map(option => <label className="option" key={option.id} data-selected={plush[field] === option.id}>
        <input type="radio" name={`${radioId}-${field}`} value={option.id} checked={plush[field] === option.id} aria-label={option.label}
          onChange={() => change(encodePlushAvatar({ ...plush, [field]: option.id }))}/>
        {field === "shape" ? <PlushAvatar config={{ ...plush, shape: option.id, glasses: "none", hat: "none" } as PlushAvatarConfig} size={42}/>
          : option.id === "none" ? <WandIcon name="circle" size={16}/> : <PlushAvatar config={{ ...plush, [field]: option.id }} size={31}/>}
        <span>{option.label.replace("眼镜", "框").replace("无框", "无")}</span>
      </label>)}</div>
    </fieldset>;
  const previewLabel = !plushPreview ? identity.avatar.startsWith("cat:") ? "保留原有像素猫" : "图片预览"
    : renderer === "webgl" ? reducedMotion ? "3D 静态预览 · 已减少动效" : "3D 预览"
    : renderer === "loading" ? "正在加载 3D…"
    : renderStatus.reason === "runtime-load" ? "静态预览 · 3D 组件未能加载" : "静态预览 · 当前浏览器 3D 不可用";
  const preserved = !plushPreview || identity.avatar.startsWith("plush-cat:");

  return <aside className="appearance" aria-label="头像工作区" aria-busy={processing} onKeyDown={event => {
    if (event.key === "Escape" && (processing || onClose)) {
      event.preventDefault(); event.stopPropagation();
      if (processing) { cancelUpload(); setError(""); } else close();
    }
  }}>
    <div className="aside-title"><span><WandIcon name="image" size={15}/>头像</span>{onClose && <WandIconButton type="button" aria-label="收起头像工作区" onClick={close}><WandIcon name="close" size={15}/></WandIconButton>}</div>
    <div className="avatar-stage">
      <WorkspaceFace key={rendererKey} employee={identity} size={136} interactive speaking={speech && renderer === "webgl" && !reducedMotion}
        onRendererChange={(state, reason) => setRenderStatus({ key: rendererKey, renderer: state, reason })}/>
      <div className="preview-state" role="status"><i data-live={plushPreview && renderer === "webgl" && !reducedMotion}/>{previewLabel}</div>
      {plushPreview && renderer === "fallback" && renderStatus.reason === "runtime-load" && <WandButton type="button" size="small" kind="ghost" disabled={busy} onClick={() => { setSpeech(false); retryPlushAvatarRuntime(); }}>重新加载 3D</WandButton>}
      {plushPreview && <WandButton type="button" size="small" kind="ghost" aria-pressed={speech} disabled={busy || reducedMotion || renderer !== "webgl"} onClick={() => setSpeech(value => !value)}>
        <WandIcon name="audio" size={14}/>{speech ? "停止动作预览" : "预览说话动作"}
      </WandButton>}
    </div>
    {fixedAvatar ? <div className="fixed-avatar"><WandIcon name="lock" size={16}/><strong>系统固定头像</strong><p>{fixedAvatar.endsWith(":silver") ? "沿用华杰的银渐层猫形象" : "沿用石一的橘猫形象"}<br/>头像由系统固定，其他资料可编辑。</p></div> : <>
      <div className="avatar-modes">
        <WandButton type="button" size="small" kind="ghost" onClick={() => fileInput.current?.click()} disabled={busy}><WandIcon name="image" size={14}/>上传图片</WandButton>
        <WandButton type="button" size="small" kind="ghost" onClick={() => change("")} disabled={busy || !employee.avatar}>恢复默认</WandButton>
      </div>
      <small className="upload-note">PNG、JPEG、WebP · 最大 10 MB</small>
      <input hidden type="file" ref={fileInput} accept="image/png,image/jpeg,image/webp" aria-label="上传头像图片" disabled={busy} onChange={upload}/>
      {processing && <div className="preview-state" role="status">正在处理图片…<WandButton type="button" size="small" kind="ghost" onClick={cancelUpload}>取消处理</WandButton></div>}
      {error && <div className="feedback error" role="alert">{error}</div>}
      {preserved ? <div className="preserved"><p>现有头像保持原样。</p><WandButton type="button" size="small" disabled={busy} onClick={() => change(encodePlushAvatar(defaultPlushAvatar(employee)))}>改用毛绒头像</WandButton></div> : <>
        {optionGroup("shape", "造型", PLUSH_SHAPES)}
        <fieldset className="option-group colors" disabled={busy}><legend>颜色<span>{PLUSH_COLORS.find(color => color.id === plush.color)?.label}</span></legend>
          <div className="options">{PLUSH_COLORS.map(option => <label className="color-option" key={option.id} data-selected={plush.color === option.id} title={option.label}>
            <input type="radio" name={`${radioId}-color`} value={option.id} aria-label={option.label} checked={plush.color === option.id} onChange={() => change(encodePlushAvatar({ ...plush, color: option.id }))}/>
            <span style={{ background: option.color }}/>
          </label>)}</div>
        </fieldset>
        {optionGroup("glasses", "眼镜", PLUSH_GLASSES)}{optionGroup("hat", "帽子", PLUSH_HATS)}
      </>}
    </>}
    <div className="context-preview"><span>在工作台中的显示</span><div><WorkspaceFace employee={identity} size={28}/><span>{employee.name || "员工名字"}<small>导航与对话共用同一身份</small></span></div></div>
    <small className="aside-foot">头像与资料统一保存，取消可撤销修改。</small>
  </aside>;
}
