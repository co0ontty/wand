import { wandOverlay } from "../overlay-controller";

/**
 * 删除会话的统一确认：作用范围与“不可撤销”只在这一处说明，避免每个列表各写一套确认。
 * 返回是否得到明确确认；取消、Escape、外点都不算确认。
 */
export async function confirmSessionDelete(label: string): Promise<boolean> {
  const answer = await wandOverlay.dialog({
    title: `删除会话「${label}」？`,
    description: "将停止此会话并删除记录，无法撤销。任务和其他会话保留。",
    actions: [
      { label: "取消", value: false, autoFocus: true },
      { label: "删除会话", value: true, kind: "danger" },
    ],
  });
  return answer.dismissed !== true && Boolean(answer.action);
}
