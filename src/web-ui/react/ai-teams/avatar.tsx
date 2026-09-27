import * as React from "react";
import type { AiTeamMember } from "../../../ai-team-types";
import { ProviderLogo } from "../provider-logo";
import { classNames } from "../ui/class-names";
import { CAT_COATS, catCoatGrid, memberCoatIndex } from "./cat-coats";

export { CAT_COATS, memberCoatIndex };

/**
 * 团队成员头像：沿用聊天里的 10×10 像素猫，毛色按成员 id 哈希或由用户指定；
 * 也可以换成上传的小图。
 */
export function PixelCat({ coat }: { coat: number }): React.ReactElement {
  const grid = catCoatGrid(coat);
  return <svg className="wand-team-avatar-cat" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">
    {grid.flatMap((row, y) => row.map((fill, x) => fill
      ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill}/>
      : null))}
  </svg>;
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
  const upload = member.avatar?.startsWith("data:image/") ? member.avatar : "";
  return <span
    className={classNames("wand-team-avatar", className)}
    data-size={size}
    data-state={state === "idle" ? undefined : state}
    data-leader={member.isLeader || undefined}
    title={member.name}
  >
    <span className="wand-team-avatar-face">
      {upload ? <img src={upload} alt=""/> : <PixelCat coat={memberCoatIndex(member)}/>}
    </span>
    {member.isLeader ? <span className="wand-team-avatar-crown" aria-hidden="true">
      <svg viewBox="0 0 12 8"><path d="M1 7 0 1l3.5 2.5L6 0l2.5 3.5L12 1l-1 6Z"/></svg>
    </span> : null}
    {showProvider ? <span className="wand-team-avatar-provider"><ProviderLogo provider={member.agent.provider}/></span> : null}
  </span>;
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
  const shown = ordered.slice(0, max);
  return <span className="wand-team-avatar-stack" data-size={size}>
    {shown.map((member, index) => <TeamAvatar key={member.id || index} member={member} size={size}/>)}
    {ordered.length > max ? <span className="wand-team-avatar-more">+{ordered.length - max}</span> : null}
  </span>;
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
