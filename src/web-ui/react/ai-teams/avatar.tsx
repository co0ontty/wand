import * as React from "react";
import { Avatar, Badge } from "antd";
import { WandUiBoundary } from "../theme";
import type { AiTeamMember } from "../../../ai-team-types";
import { ProviderLogo } from "../provider-logo";
import { classNames } from "../ui/class-names";
import { CAT_COATS, catCoatGrid, memberCoatIndex } from "./cat-coats";
import {
  avatarFace,
  generatedAvatarBackground,
  generatedAvatarFace,
  type AvatarFace,
  type AvatarIdentity,
  type GeneratedAvatarFace,
} from "./generated-avatar";

export { CAT_COATS, memberCoatIndex };
export {
  GENERATED_AVATAR_COATS,
  GENERATED_AVATAR_TEXT,
  avatarFace,
  generatedAvatarBackground,
  generatedAvatarFace,
  generatedAvatarGlyph,
  generatedAvatarSeed,
  type AvatarFace,
  type GeneratedAvatarCoat,
  type GeneratedAvatarFace,
} from "./generated-avatar";

/**
 * 聊天里的 10×10 像素猫：只在成员**显式挑过毛色**（`cat:<n>`）时才画。
 * 没自定义过头像走 [GeneratedAvatarGlyph]，毛色表本身仍是选择器里的八颗钮。
 */
export function PixelCat({ coat }: { coat: number }): React.ReactElement {
  const grid = catCoatGrid(coat);
  return <svg className="wand-team-avatar-cat" width="74%" height="74%" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">
    {grid.flatMap((row, y) => row.map((fill, x) => fill
      ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill}/>
      : null))}
  </svg>;
}

/** 默认头像的字形：名字首字压在按身份选出的渐变底上，尺寸跟着头像走。 */
export function GeneratedAvatarGlyph({ face, size }: {
  face: GeneratedAvatarFace;
  size: number;
}): React.ReactElement {
  return <span className="wand-generated-avatar-glyph" aria-hidden="true"
    style={{ display: "block", fontSize: Math.max(10, Math.round(size * 0.42)), fontWeight: 600, lineHeight: 1, color: face.text }}>
    {face.glyph}
  </span>;
}

/** Ant Avatar 的三个投影位：图片走 src，猫/字形走 icon，生成底色走 style。 */
export interface AvatarFaceParts {
  src?: string;
  style?: React.CSSProperties;
  icon?: React.ReactNode;
}

export function avatarFaceParts(identity: AvatarIdentity, size: number): AvatarFaceParts {
  const face: AvatarFace = avatarFace(identity) ?? { kind: "generated", face: generatedAvatarFace(identity) };
  if (face.kind === "upload") return { src: face.src };
  if (face.kind === "cat") return { icon: <PixelCat coat={face.coat}/> };
  return {
    style: generatedAvatarBackground(face.face),
    icon: <GeneratedAvatarGlyph face={face.face} size={size}/>,
  };
}


/** 状态环：工作中呼吸、完成打勾、失败变红、等你处理亮黄点。 */
export type TeamAvatarState = "idle" | "working" | "done" | "failed" | "waiting";

export function TeamAvatar({
  member,
  size = "md",
  state = "idle",
  showProvider = false,
  className,
}: {
  member: Pick<AiTeamMember, "id" | "name" | "avatar" | "isLeader" | "agent">;
  size?: "sm" | "md" | "lg";
  state?: TeamAvatarState;
  showProvider?: boolean;
  className?: string;
}): React.ReactElement {
  const pixelSize = { sm: 26, md: 32, lg: 44 }[size];
  const stateColor = state === "done" ? "var(--success)" : state === "failed" ? "var(--danger)"
    : state === "waiting" ? "var(--warning)" : state === "working" ? "var(--info)" : undefined;
  const face = avatarFaceParts(member, pixelSize);
  return <WandUiBoundary><Badge
    className={classNames("wand-team-avatar", className)} data-size={size}
    data-state={state === "idle" ? undefined : state} data-leader={member.isLeader || undefined} title={member.name}
    offset={[-pixelSize / 2, -4]} count={member.isLeader ? <span aria-hidden="true" style={{ color: "var(--warning)" }}>♛</span> : undefined}>
    <Badge offset={[0, pixelSize]} count={state === "done" ? <Avatar size={16} style={{ background: stateColor }} icon={<span>✓</span>}/>
      : showProvider ? <Avatar size={18} shape="square" icon={<ProviderLogo provider={member.agent.provider}/>}/> : undefined}>
      <Avatar shape="square" size={pixelSize} src={face.src}
        style={{ ...face.style, outline: stateColor ? `2px solid ${stateColor}` : undefined, outlineOffset: 1 }}
        icon={face.icon}/>
    </Badge>
  </Badge></WandUiBoundary>;
}

/** 叠放的头像组：负责人排第一，超出的部分折成「+N」。 */
export function TeamAvatarStack({
  members,
  max = 5,
  size = "sm",
}: {
  members: ReadonlyArray<Pick<AiTeamMember, "id" | "name" | "avatar" | "isLeader" | "agent">>;
  max?: number;
  size?: "sm" | "md";
}): React.ReactElement {
  const ordered = [...members].sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
  return <WandUiBoundary><Avatar.Group className="wand-team-avatar-stack" data-size={size} max={{ count: max }}>
    {ordered.map((member, index) => <TeamAvatar key={member.id || index} member={member} size={size}/>)}
  </Avatar.Group></WandUiBoundary>;
}

/** 把上传的图片缩成 96px 方图，控制在服务端的头像大小上限内。 */
export async function shrinkAvatarImage(file: File, maxChars: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("图片读取失败。"));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片裁剪。");
    // 居中裁成正方形，再缩放。
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 96, 96);
    const data = canvas.toDataURL("image/jpeg", 0.8);
    if (data.length > maxChars) throw new Error("图片太大，请换一张。");
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}
