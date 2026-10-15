import * as React from "react";
import { Typography } from "antd";
import { WandButton } from "../../ui/button.js";
import { WandIcon } from "../../ui/icons.js";
import { WandPopover } from "../../ui/popover.js";
import type { TurnNavEntry } from "./turn-nav-model.js";
import { installTurnNavStyles } from "./styles.js";

export interface TurnNavPanelProps {
  scope: string;
  entries: readonly TurnNavEntry[];
  range: string;
  active?: boolean;
  readingRoot?: () => HTMLElement | null;
  ownerAttribute?: "data-chat-owner" | "data-presentation-id" | "data-conversation-nav-owner";
  onJump(ownerKey: string): boolean;
}
/** One compact trigger on desktop and mobile; previews appear only on demand. */
export function TurnNavPanel({ scope, entries, range, active = true, readingRoot, ownerAttribute = "data-chat-owner", onJump }: TurnNavPanelProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState<string | null>(null);
  React.useLayoutEffect(() => {
    const root = readingRoot?.();
    if (!root || !active) { setCurrent(null); return; }
    let frame = 0;
    const measure = (): void => {
      const bounds = root.getBoundingClientRect();
      const owners = new Set(entries.map(entry => entry.ownerKey));
      const rows = Array.from(root.querySelectorAll<HTMLElement>(`[${ownerAttribute}]`))
        .filter(node => owners.has(node.getAttribute(ownerAttribute) || "") && node.getClientRects().length)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const edge = bounds.top + Math.min(80, bounds.height / 3);
      const preceding = rows.filter(node => node.getBoundingClientRect().top <= edge);
      const target = preceding.at(-1) ?? rows.find(node => node.getBoundingClientRect().top < bounds.bottom);
      setCurrent(target?.getAttribute(ownerAttribute) ?? null);
    };
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    root.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule); observer.observe(root);
    measure();
    return () => { cancelAnimationFrame(frame); root.removeEventListener("scroll", schedule); observer.disconnect(); };
  }, [scope, active, entries, readingRoot, ownerAttribute]);
  const [error, setError] = React.useState("");
  const id = React.useId();
  React.useLayoutEffect(installTurnNavStyles, []);
  React.useEffect(() => { setOpen(false); setError(""); }, [scope, active]);
  if (!active || !entries.length) return null;
  return <div className="turn-nav-dock" data-turn-nav-scope={scope}>
    <span className="turn-nav-reading">{entries.find(entry => entry.ownerKey === current)?.label ? `正在阅读：${entries.find(entry => entry.ownerKey === current)!.label}` : "尚未定位提问"}</span>
    <WandPopover open={open} onOpenChange={next => { setOpen(next); setError(""); }} align="end" side="bottom"
      ariaLabel="提问目录" contentId={id} contentRole="navigation" className="turn-nav-popover"
      trigger={<WandButton className="turn-nav-trigger" aria-label={`提问目录，当前已载入 ${entries.length} 个提问`}
        aria-expanded={open} aria-controls={open ? id : undefined} title={range}>
        <WandIcon name="history" size={14}/><span>提问 · {entries.length}</span>
      </WandButton>}>
      <div className="turn-nav-directory">
        <Typography.Text type="secondary" className="turn-nav-range">{range}</Typography.Text>
        <ol className="turn-nav-list">{entries.map(entry => <li key={entry.ownerKey}>
          <WandButton kind="ghost" className="turn-nav-entry" data-turn-nav-owner={entry.ownerKey}
            aria-current={entry.ownerKey === current ? "location" : undefined}
            title={entry.preview} onClick={() => {
              if (onJump(entry.ownerKey)) { setError(""); setOpen(false); }
              else setError("这条提问已不在当前载入范围，请重新打开目录。");
            }}><span className="turn-nav-label">{entry.label}</span><span className="turn-nav-preview">{entry.preview}</span></WandButton>
        </li>)}</ol>
        {error ? <Typography.Text type="danger" role="status">{error}</Typography.Text> : null}
      </div>
    </WandPopover>
  </div>;
}
