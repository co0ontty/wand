import * as React from "react";
import { WandSelect, type WandSelectProps } from "../ui/select";
import type { Workspace } from "./types";
import { requestAddWorkspace } from "./controller";

/** Workspace selection always has the same explicit registration action. */
export function WorkspaceSelect({ onWorkspaceCreated, ...props }: WandSelectProps & { onWorkspaceCreated?(workspace: Workspace): void }) {
  const [created, setCreated] = React.useState<Workspace[]>([]);
  const options = [...props.options, ...created.filter(workspace => !props.options.some(option => option.value === workspace.id)).map(workspace => ({ value: workspace.id, label: workspace.name }))];
  return <WandSelect {...props} options={options} popupAction={{ label: "＋ 添加工作区", onClick: () => requestAddWorkspace("", workspace => {
    setCreated(previous => [...previous.filter(item => item.id !== workspace.id), workspace]);
    if (onWorkspaceCreated) onWorkspaceCreated(workspace);
    else props.onValueChange?.(workspace.id);
  }, props.popupOwner || props.ariaLabel) }}/>;
}
