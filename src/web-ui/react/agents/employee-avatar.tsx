import * as React from "react";
import { memberCoatIndex, PixelCat, shrinkAvatarImage } from "../ai-teams/avatar.js";
import { CAT_COATS } from "../ai-teams/cat-coats.js";
import { WandButton, WandIcon } from "../ui";
import { SILICON_EMPLOYEE_AVATAR_MAX_CHARS } from "../../../ai-team-types.js";

export function EmployeeAvatar({
  employee,
  size = "md",
  className = "",
}: {
  employee: { id: string; name: string; avatar?: string };
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}): React.ReactElement {
  const upload = employee.avatar?.startsWith("data:image/") ? employee.avatar : "";
  const cls = `wand-team-avatar ${className}`.trim();
  return (
    <span
      className={cls}
      data-size={size}
      title={employee.name}
    >
      <span className="wand-team-avatar-face">
        {upload ? <img src={upload} alt="" /> : <PixelCat coat={memberCoatIndex(employee)} />}
      </span>
    </span>
  );
}

export function EmployeeAvatarPicker({
  avatar,
  name,
  disabled,
  onChange,
}: {
  avatar: string;
  name: string;
  disabled: boolean;
  onChange(avatar: string): void;
}): React.ReactElement {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const selectedIndex = memberCoatIndex({ id: "custom", name, avatar });

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    shrinkAvatarImage(file, SILICON_EMPLOYEE_AVATAR_MAX_CHARS)
      .then((dataUrl) => {
        onChange(dataUrl);
      })
      .catch((err) => {
        console.error("缩小头像失败", err);
      });
  };

  return <div className="wand-team-avatar-picker" role="group" aria-label="员工头像">
    <EmployeeAvatar employee={{ id: "preview", name, avatar }} size="lg" />
    {CAT_COATS.map((coat, idx) => <button
      key={coat.name}
      type="button"
      className="wand-team-coat"
      title={coat.name}
      aria-label={coat.name}
      aria-pressed={!avatar.startsWith("data:") && selectedIndex === idx}
      disabled={disabled}
      onClick={() => onChange(`cat:${idx}`)}
    >
      <PixelCat coat={idx} />
    </button>)}
    <button
      type="button"
      className="wand-team-coat is-upload"
      title="上传头像图片"
      aria-label="上传头像图片"
      aria-pressed={avatar.startsWith("data:")}
      disabled={disabled}
      onClick={() => fileInputRef.current?.click()}
    >
      <WandIcon name="image" size={14} />
    </button>
    <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFileChange}/>
    {avatar ? <WandButton kind="ghost" size="small" disabled={disabled} onClick={() => onChange("")}>重置</WandButton> : null}
  </div>;
}
