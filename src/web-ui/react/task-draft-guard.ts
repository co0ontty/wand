import { wandOverlay } from "./overlay-controller";

/** The two task entry points share the same unsaved-draft decision. */
export async function confirmDiscardTaskDraft(): Promise<boolean> {
  const answer = await wandOverlay.dialog({
    title: "放弃未创建的任务？",
    description: "填写的任务内容尚未保存。继续编辑可保留当前输入。",
    actions: [
      { label: "继续编辑", value: false, autoFocus: true },
      { label: "放弃草稿", value: true, kind: "danger" },
    ],
  });
  return answer.dismissed === false && answer.action === true;
}
