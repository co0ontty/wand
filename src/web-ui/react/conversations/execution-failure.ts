export type ExecutionFailure = { summary: string; action: "model" | "login" | "inspect"; actionLabel: string };

/** Classify only explicit failure facts; raw transcripts remain available in details. */
export function executionFailure(text: string): ExecutionFailure {
  if (/model[^\n]*(?:not found|does not exist|unknown|unavailable)|(?:找不到|不存在|无效|不可用)[^\n]*模型|模型[^\n]*(?:找不到|不存在|不可用)/i.test(text)) {
    return { summary: "执行未完成：配置的模型不可用。请检查员工的模型与候选配置。", action: "model", actionLabel: "检查模型配置" };
  }
  if (/unauthori[sz]ed|authentication|not logged in|token[^\n]*expired|未登录|登录[^\n]*(?:失效|过期)|认证失败|凭据[^\n]*(?:过期|失效)/i.test(text)) {
    return { summary: "执行未完成：工具的登录或认证不可用。请在执行窗口检查登录状态。", action: "login", actionLabel: "检查工具登录" };
  }
  return { summary: "这项工作未完成。请查看错误详情与执行记录。", action: "inspect", actionLabel: "查看执行记录" };
}
