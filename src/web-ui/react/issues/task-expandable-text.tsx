import * as React from "react";
import { WandButton } from "../ui/button";

/**
 * 任务面板里所有「长文本先露一段、可展开全文」的唯一实现：
 * 证据、阻塞、范围、描述都用它，文案固定为「展开全文 / 收起」。
 * 折叠时按行数截断并渐隐；内容本身不够长时不显示按钮。
 */
export function TaskExpandableText({ children, lines = 4, className = "", plain = false }: {
  children: React.ReactNode; lines?: number; className?: string;
  /** true 时按纯文本保留换行（pre-wrap）；Markdown 预览等富内容传 false。 */
  plain?: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [overflowing, setOverflowing] = React.useState(false);
  const body = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  React.useLayoutEffect(() => {
    const node = body.current;
    if (!node || expanded) return;
    const measure = (): void => setOverflowing(node.scrollHeight > node.clientHeight + 2);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [children, expanded, lines]);
  return <div className={`task-expandable ${className}`.trim()}>
    <div ref={body} id={id} className="task-expandable-body" data-plain={plain || undefined}
      data-clamped={!expanded || undefined} data-overflowing={overflowing && !expanded || undefined}
      style={{ "--task-expandable-lines": lines } as React.CSSProperties}>{children}</div>
    {(overflowing || expanded) && <WandButton kind="ghost" size="small" className="task-expandable-toggle"
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开全文"}</WandButton>}
  </div>;
}
