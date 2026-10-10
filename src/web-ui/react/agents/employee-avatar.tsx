import * as React from "react";
import { Alert, Avatar, Badge, Button, Flex, Typography } from "antd";
import { WandUiBoundary } from "../theme";
import { avatarFaceParts, shrinkAvatarImage } from "../ai-teams/avatar.js";
import { WandButton, WandIcon, WandPopover } from "../ui";
import { SILICON_EMPLOYEE_AVATAR_MAX_CHARS } from "../../../ai-team-types.js";
import { employeeAvatarProvider, employeeCliLabel } from "./employee-identity.js";
import { ProviderLogo } from "../provider-logo.js";
import { PlushAvatar } from "../avatars/plush-avatar.js";
import { defaultPlushAvatar, encodePlushAvatar, resolvePlushAvatar, resolveEmployeeAvatar, PLUSH_SHAPES, PLUSH_COLORS, PLUSH_GLASSES, PLUSH_HATS, type PlushAvatarConfig } from "../../../plush-avatar.js";
import { usePopupDismiss } from "../ui/popup-lifecycle.js";
import { installAvatarEditorStyles } from "./employee-avatar-styles.js";

export function EmployeeAvatar({ employee, provider, size = "md", className = "", speaking = false }: {
  employee: { id: string; name: string; avatar?: string; agents?: ReadonlyArray<{ provider?: string; engine?: "cli" | "sdk" }> };
  provider?: string;
  size?: "sm" | "md" | "lg" | "xl" | "chat";
  className?: string;
  /** Audio playback owners may set this only while this employee is actually speaking. Work status is separate. */
  speaking?: boolean;
}): React.ReactElement {
  const cli = employeeAvatarProvider(employee, provider);
  const cliLabel = cli ? employeeCliLabel(cli, provider === undefined ? employee.agents?.[0]?.engine : undefined) : "";
  const pixelSize = { sm: 26, md: 32, lg: 44, xl: 72, chat: 40 }[size];
  const providerSize = pixelSize <= 32 ? 14 : 18;
  const plush = resolveEmployeeAvatar(employee);
  const face = plush ? null : avatarFaceParts(employee, pixelSize);
  return <WandUiBoundary><Badge className={`wand-team-avatar wand-employee-avatar ${className}`.trim()} data-size={size}
    title={employee.name} offset={[0, pixelSize]}
    count={cli ? <span role="img" aria-label={cliLabel} title={cliLabel} className="wand-employee-avatar-provider"><Avatar size={providerSize} shape="square" icon={<ProviderLogo provider={cli}/>} /></span> : undefined}>
    {plush ? <PlushAvatar config={plush} size={pixelSize} speaking={speaking}/>
      : <Avatar shape="square" size={pixelSize} src={face?.src} style={face?.style} icon={face?.icon}/>}
  </Badge></WandUiBoundary>;
}

const shapePaths: Record<PlushAvatarConfig["shape"], string> = {
  heart: "M12 20C10 18 3 13 3 8.5C3 3 10 2 12 7C14 2 21 3 21 8.5C21 13 14 18 12 20Z",
  triangle: "M9 5Q12 1 15 5L21 16Q23 20 18 20H6Q1 20 3 16Z",
  diamond: "M10 3Q12 1 14 3L21 10Q23 12 21 14L14 21Q12 23 10 21L3 14Q1 12 3 10Z",
  round: "M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18Z",
  square: "M7 3H17Q21 3 21 7V17Q21 21 17 21H7Q3 21 3 17V7Q3 3 7 3Z",
  capsule: "M12 2Q19 2 19 9V15Q19 22 12 22Q5 22 5 15V9Q5 2 12 2Z",
};

function OptionMark({ field, id }: { field: keyof Pick<PlushAvatarConfig, "shape" | "color" | "glasses" | "hat">; id: string }) {
  if (field === "color") return <span className="wand-avatar-color" style={{ background: PLUSH_COLORS.find(item => item.id === id)?.color }}/>;
  if (field === "shape") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={shapePaths[id as PlushAvatarConfig["shape"]]}/></svg>;
  if (id === "none") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none"/><path d="M6 18L18 6" fill="none"/></svg>;
  if (field === "glasses") return <svg viewBox="0 0 24 24" aria-hidden="true" style={{ color: id === "gold" ? "#9b7135" : "currentColor" }}><circle cx="6.5" cy="12" r="4.5" fill="none"/><circle cx="17.5" cy="12" r="4.5" fill="none"/><path d="M11 12h2M2 10H0M22 10h2" fill="none"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true">{id === "beanie" ? <><path d="M5 15C5 3 19 3 19 15Z"/><rect x="4" y="15" width="16" height="4" rx="1"/><circle cx="12" cy="3" r="2"/></> : <><path d="M3 13C0 4 21 3 22 11C22 16 6 18 3 13Z"/><path d="M7 17h11M14 5l1-3" fill="none"/></>}</svg>;
}

function AvatarOptions<F extends "shape" | "color" | "glasses" | "hat">({ field, label, options, config, onChange, disabled }: {
  field: F; label: string; options: ReadonlyArray<{ id: PlushAvatarConfig[F]; label: string }>; config: PlushAvatarConfig;
  onChange(config: PlushAvatarConfig): void; disabled?: boolean;
}) {
  const groupName = React.useId();
  return <fieldset className="wand-avatar-options" disabled={disabled}><legend>{label}<span>{options.find(option => option.id === config[field])?.label}</span></legend>
    <div className="wand-avatar-option-row">{options.map(option => <label className="wand-avatar-option" key={option.id} data-selected={config[field] === option.id}>
      <input type="radio" name={groupName} value={option.id} checked={config[field] === option.id} aria-label={option.label}
        onChange={() => onChange({ ...config, [field]: option.id })}/>
      <span className="wand-avatar-option-mark"><OptionMark field={field} id={option.id}/></span>
      <span className="wand-avatar-option-name">{option.label}</span>
    </label>)}</div>
  </fieldset>;
}

/** Local preview is a transaction: only Apply changes the employee form draft; the form's Save owns persistence. */
export function EmployeeAvatarPicker({ avatar, name, employeeId = "", disabled, onChange, onBusyChange }: {
  avatar: string; name: string; employeeId?: string; disabled: boolean;
  onChange(avatar: string): void; onBusyChange?(busy: boolean): void;
}): React.ReactElement {
  const identity = { id: employeeId || "employee-draft", name, avatar };
  const trigger = React.useRef<HTMLButtonElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const editor = React.useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<PlushAvatarConfig>(() => resolvePlushAvatar(identity) ?? defaultPlushAvatar(identity));
  const [error, setError] = React.useState("");
  const [processing, setProcessing] = React.useState(false);
  const [speechPreview, setSpeechPreview] = React.useState(false);
  const epoch = React.useRef(0);
  const openedAvatar = React.useRef(avatar);
  const busy = disabled || processing;
  React.useEffect(() => { installAvatarEditorStyles(); }, []);
  React.useEffect(() => () => { ++epoch.current; }, []);
  React.useEffect(() => { onBusyChange?.(processing); }, [processing, onBusyChange]);
  React.useEffect(() => {
    // External replacement makes an in-flight decode or stale sculpt draft ineligible to apply.
    ++epoch.current;
    setProcessing(false);
    if (open && openedAvatar.current !== avatar) { setOpen(false); setSpeechPreview(false); setError("头像已更新，请重新打开捏脸。"); }
  }, [avatar]);
  React.useEffect(() => {
    if (open) { const frame = requestAnimationFrame(() => editor.current?.querySelector<HTMLInputElement>("input:checked")?.focus()); return () => cancelAnimationFrame(frame); }
  }, [open]);
  const close = () => { setOpen(false); setSpeechPreview(false); trigger.current?.focus({ preventScroll: true }); };
  usePopupDismiss(open, close);
  const begin = () => { setMenuOpen(false); setError(""); openedAvatar.current = avatar; setDraft(resolvePlushAvatar(identity) ?? defaultPlushAvatar(identity)); setOpen(true); };
  const upload = () => { setMenuOpen(false); setError(""); fileInput.current?.click(); };
  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) { setError("请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。"); return; }
    setProcessing(true); setError(""); const generation = ++epoch.current;
    void shrinkAvatarImage(file, SILICON_EMPLOYEE_AVATAR_MAX_CHARS).then(data => {
      if (generation === epoch.current) { setOpen(false); setSpeechPreview(false); onChange(data); }
    }).catch((cause: unknown) => { if (generation === epoch.current) setError(cause instanceof Error ? cause.message : "图片处理失败，请重试。"); })
      .finally(() => { if (generation === epoch.current) setProcessing(false); });
  };
  const mode = avatar.startsWith("data:image/") ? "已上传图片" : avatar.startsWith("plush:v1:") ? "自定义毛绒头像" : /^cat:/.test(avatar) ? "像素猫头像" : "自动毛绒头像";
  return <section className="wand-avatar-editor" aria-label="员工头像">
    <Flex align="center" gap={10} className="wand-avatar-editor-summary">
      <WandPopover open={menuOpen && !busy} onOpenChange={setMenuOpen} align="start" ariaLabel="头像操作" trigger={
        <Button ref={trigger} className="wand-avatar-editor-trigger" type="text" disabled={busy} aria-label="编辑员工头像" aria-haspopup="true" aria-expanded={menuOpen || open}>
          <EmployeeAvatar employee={identity} provider="" size="lg"/><span className="wand-avatar-edit-mark"><WandIcon name="edit" size={10}/></span>
        </Button>
      }><Flex vertical gap={2}>
        <WandButton kind="ghost" onClick={upload}><WandIcon name="image" size={14}/>上传图片</WandButton>
        <WandButton kind="ghost" onClick={begin}>捏脸</WandButton>
      </Flex></WandPopover>
      <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}><Typography.Text>头像</Typography.Text><Typography.Text type="secondary" className="wand-avatar-editor-caption">{processing ? "正在处理图片…" : mode}</Typography.Text></Flex>
      <WandButton kind="ghost" size="small" disabled={busy} onClick={begin}>捏脸</WandButton>
      <WandButton kind="ghost" size="small" disabled={busy} onClick={upload}>上传</WandButton>
      {avatar ? <WandButton kind="ghost" size="small" disabled={busy} onClick={() => { close(); setError(""); onChange(""); }}>恢复默认</WandButton> : null}
    </Flex>
    <Typography.Text type="secondary" className="wand-avatar-upload-hint">PNG、JPEG 或 WebP · 最大 10 MB</Typography.Text>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden tabIndex={-1} aria-label="上传头像图片" onChange={onFile}/>
    {open ? <div ref={editor} className="wand-avatar-sculpt" role="region" aria-label="捏脸" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <div className="wand-avatar-sculpt-preview"><PlushAvatar config={draft} size={156} interactive speaking={speechPreview}/>
        <Typography.Text type="secondary">实时预览</Typography.Text>
        <WandButton kind="ghost" size="small" aria-pressed={speechPreview} disabled={busy} onClick={() => setSpeechPreview(value => !value)}>{speechPreview ? "停止预览" : "预览说话动作"}</WandButton>
      </div>
      <div className="wand-avatar-sculpt-controls">
        <AvatarOptions field="shape" label="造型" options={PLUSH_SHAPES} config={draft} disabled={busy} onChange={setDraft}/>
        <AvatarOptions field="color" label="颜色" options={PLUSH_COLORS} config={draft} disabled={busy} onChange={setDraft}/>
        <AvatarOptions field="glasses" label="眼镜" options={PLUSH_GLASSES} config={draft} disabled={busy} onChange={setDraft}/>
        <AvatarOptions field="hat" label="帽子" options={PLUSH_HATS} config={draft} disabled={busy} onChange={setDraft}/>
      </div>
      <Flex className="wand-avatar-sculpt-footer" align="center" wrap gap={8} justify="space-between">
        <Typography.Text type="secondary">保存员工后生效</Typography.Text>
        <Flex gap={6}><WandButton kind="ghost" disabled={busy} onClick={close}>取消</WandButton><WandButton kind="primary" disabled={busy} onClick={() => { onChange(encodePlushAvatar(draft)); close(); }}>使用这个头像</WandButton></Flex>
      </Flex>
    </div> : null}
    {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
  </section>;
}
