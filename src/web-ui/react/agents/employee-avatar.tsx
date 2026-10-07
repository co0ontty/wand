import * as React from "react";
import { Alert, Avatar, Badge, Button, Flex, Tooltip } from "antd";
import { WandUiBoundary } from "../theme";
import { avatarFaceParts, PixelCat, shrinkAvatarImage } from "../ai-teams/avatar.js";
import { CAT_COATS } from "../ai-teams/cat-coats.js";
import { WandButton, WandIcon } from "../ui";
import { SILICON_EMPLOYEE_AVATAR_MAX_CHARS } from "../../../ai-team-types.js";
import { employeeAvatarProvider, employeeCliLabel } from "./employee-identity.js";
import { ProviderLogo } from "../provider-logo.js";

export function EmployeeAvatar({
  employee,
  provider,
  size = "md",
  className = "",
}: {
  employee: { id: string; name: string; avatar?: string; agents?: ReadonlyArray<{ provider?: string }> };
  provider?: string;
  size?: "sm" | "md" | "lg" | "xl" | "chat";
  className?: string;
}): React.ReactElement {
  const cli = employeeAvatarProvider(employee, provider);
  const cliLabel = cli ? employeeCliLabel(cli) : "";
  const pixelSize = { sm: 26, md: 32, lg: 44, xl: 72, chat: 40 }[size];
  const face = avatarFaceParts(employee, pixelSize);
  return <WandUiBoundary><Badge className={`wand-team-avatar wand-employee-avatar ${className}`.trim()} data-size={size}
    title={employee.name} offset={[0, pixelSize]}
    count={cli ? <span role="img" aria-label={cliLabel} title={cliLabel} className="wand-employee-avatar-provider"><Avatar size={18} shape="square" icon={<ProviderLogo provider={cli}/>} /></span> : undefined}>
    <Avatar shape="square" size={pixelSize} src={face.src} style={face.style} icon={face.icon}/>
  </Badge></WandUiBoundary>;
}

/**
 * 员工头像：八种毛色 + 上传小图，控件走通用圆钮；没挑也没上传就是系统生成的默认头像，
 * 此时八个毛色钮都不算选中。上传失败就地显示原因，不改动已选头像。
 */
export function EmployeeAvatarPicker({
  avatar,
  name,
  disabled,
  onChange,
  onBusyChange,
}: {
  avatar: string;
  name: string;
  disabled: boolean;
  onChange(avatar: string): void;
  onBusyChange?(busy: boolean): void;
}): React.ReactElement {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState("");
  const selectedMatch = /^cat:(\d+)$/.exec(avatar);
  const [processing, setProcessing] = React.useState(false);
  const epoch = React.useRef(0);
  React.useEffect(() => () => { ++epoch.current; }, []);
  React.useEffect(() => { onBusyChange?.(processing); }, [processing, onBusyChange]);
  disabled = disabled || processing;
  const selectedIndex = selectedMatch ? Number(selectedMatch[1]) % CAT_COATS.length : null;

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(""); setProcessing(true);
    const generation = ++epoch.current;
    shrinkAvatarImage(file, SILICON_EMPLOYEE_AVATAR_MAX_CHARS)
      .then((dataUrl) => { if (generation === epoch.current) onChange(dataUrl); })
      .catch((cause: unknown) => {
        if (generation === epoch.current) setError(cause instanceof Error ? cause.message : "图片处理失败。");
      }).finally(() => { if (generation === epoch.current) setProcessing(false); });
  };

  return (
    <Flex wrap gap={6} align="center" role="group" aria-label="员工头像">
      <EmployeeAvatar employee={{ id: "preview", name, avatar }} size="lg" />
      {CAT_COATS.map((coat, idx) => (
        <Tooltip key={coat.name} title={coat.name}>
          <Button
            className="wand-team-coat"
            shape="circle"
            size="small"
            aria-label={coat.name}
            aria-pressed={!avatar.startsWith("data:") && selectedIndex === idx}
            disabled={disabled}
            onClick={() => { setError(""); onChange(`cat:${idx}`); }}
          >
            <PixelCat coat={idx} />
          </Button>
        </Tooltip>
      ))}
      <Tooltip title="上传头像图片">
        <Button
          className="wand-team-coat is-upload"
          shape="circle"
          size="small"
          aria-label="上传头像图片"
          aria-pressed={avatar.startsWith("data:")}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <WandIcon name="image" size={14} />
        </Button>
      </Tooltip>
      <input ref={fileInputRef} type="file" accept="image/*" hidden tabIndex={-1} aria-label="上传头像图片" onChange={onFileChange}/>
      {avatar ? <WandButton kind="ghost" size="small" disabled={disabled} onClick={() => onChange("")}>重置</WandButton> : null}
      {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
    </Flex>
  );
}
