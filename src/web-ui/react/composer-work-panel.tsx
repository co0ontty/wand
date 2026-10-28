import * as React from "react";
import { Button, Typography } from "antd";
import { WandIcon, type WandIconName } from "./ui/icons.js";

/** Same bounded summary geometry for progress and pending input; never a second state owner. */
export function ComposerWorkSummary({ label, count, preview, icon, expanded, id, className }: {
  label: string; count: string; preview: string; icon: WandIconName; expanded: boolean; id?: string; className?: string;
}) {
  return <Button id={id} type="default" className={`composer-work-trigger ${className ?? ""}`}
    aria-expanded={expanded} aria-label={`${label}，${count}`} title={preview}>
    <span className="composer-work-summary"><WandIcon name={icon} size={16}/>
      <span className="composer-work-label">{label}<span className="composer-work-count">{count}</span></span>
      <span className="composer-work-preview">{preview}</span>
      <span className="composer-work-chevron" data-open={expanded}><WandIcon name="chevronDown" size={12}/></span>
    </span>
  </Button>;
}
export function ComposerWorkPanel({ title, description, onClose, actions, children, footer, className }: {
  title: string; description?: string; onClose(): void; actions?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; className?: string;
}) {
  return <section className={`composer-work-panel ${className ?? ""}`}>
    <header className="composer-work-header"><div><Typography.Text strong>{title}</Typography.Text>{description && <p>{description}</p>}</div>
      <div className="composer-work-header-actions">{actions}<Button type="text" size="small" aria-label={`关闭${title}`} onClick={onClose} icon={<WandIcon name="close" size={16}/>}/></div>
    </header>
    <div className="composer-work-scroll" tabIndex={0} aria-label={`${title}列表`}>{children}</div>
    {footer && <footer className="composer-work-footer">{footer}</footer>}
  </section>;
}
export function ComposerWorkText({ text, limit = 60 }: { text: string; limit?: number }) {
  const [full, setFull] = React.useState(false);
  const [overflow, setOverflow] = React.useState(false);
  const paragraph = React.useRef<HTMLParagraphElement>(null);
  const id = React.useId();
  React.useLayoutEffect(() => {
    const node = paragraph.current;
    if (!node) return;
    const measure = () => { if (!full) setOverflow(node.scrollHeight > node.clientHeight + 1); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [text, full]);
  return <div><p ref={paragraph} id={id} className="composer-work-text" data-full={full}>{text}</p>{(text.length > limit || overflow) &&
    <Button type="link" size="small" className="composer-work-read-more" aria-expanded={full} aria-controls={id} onClick={() => setFull(!full)}>{full ? "收起全文" : "展开全文"}</Button>}</div>;
}
