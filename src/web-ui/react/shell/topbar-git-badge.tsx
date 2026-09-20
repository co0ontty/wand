// 快捷提交入口（顶栏 / 任务标签栏共用）。
//
// 任务里主区顶部是标签栏而不是顶栏：只把徽章挂在顶栏上，进任务后右上角就没有
// 快捷提交的入口了（任务标签栏挤掉了顶栏）。两处共用这一个组件，点击统一走
// `topbar.gitCommit`，落到 legacy 的 quick-commit 面板。
//
// 只在当前会话处于 git 工作树时出现——是否显示由 `snapshot.topbar.git` 决定
// （首页、非 git 目录的会话由 legacy 层给出 null）。

import * as React from "react";

import { WandButton, WandIcon } from "../ui";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";

export interface TopbarGitBadgeProps {
  /** 默认是顶栏的 id；第二个宿主必须显式传自己的 id，避免同页重复 DOM id。 */
  readonly id?: string;
  readonly className?: string;
}

export function TopbarGitBadge({ id = "topbar-git-badge", className }: TopbarGitBadgeProps = {}) {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const git = snapshot.topbar.git;
  if (!git) return null;
  const title = `${git.branch}  ·  ${git.clean
    ? "工作区干净"
    : `${git.modifiedCount} 个文件待提交`}`;
  return (
    <WandButton
      id={id}
      className={className}
      kind="soft"
      size="small"
      title={title}
      aria-label="快捷提交"
      onClick={() => void dispatch({ type: "topbar.gitCommit" })}
    >
      <WandIcon name="git" slot="start" size={14} className="topbar-git-icon"/>
      <span className="topbar-git-branch">{git.branch}</span>
      {git.clean
        ? <span className="topbar-git-clean" aria-hidden="true"><WandIcon name="check" size={11}/></span>
        : <span className="topbar-git-count">·{git.modifiedCount}</span>}
    </WandButton>
  );
}
