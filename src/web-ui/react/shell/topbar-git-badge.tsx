// 顶栏与任务标签栏共用的 Git 菜单项，保留分支与改动数量。
import * as React from "react";

import { WandDropdownMenuItem } from "../ui/dropdown-menu";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";

export interface TopbarGitBadgeProps {
  /** 默认是顶栏的 id；第二个宿主必须显式传自己的 id，避免同页重复 DOM id。 */
  readonly id?: string;
  readonly className?: string;
}

export function TopbarGitMenuItem({ id = "topbar-git-badge", className }: TopbarGitBadgeProps = {}) {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const git = snapshot.topbar.git;
  if (!git) return null;
  const title = `${git.branch}  ·  ${git.clean
    ? "工作区干净"
    : `${git.modifiedCount} 个文件待提交`}`;
  return (
    <WandDropdownMenuItem
      id={id}
      className={className}
      icon="git"
      title={title}
      aria-label="快捷提交"
      onSelect={() => void dispatch({ type: "topbar.gitCommit" })}
      hint={git.clean ? "无改动" : `${git.modifiedCount} 个改动`}
    >
      快捷提交 · {git.branch}
    </WandDropdownMenuItem>
  );
}
