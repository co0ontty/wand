import * as React from "react";
import { Typography } from "antd";
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
  const [opened, setOpened] = React.useState<string | null>(null);
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
  React.useLayoutEffect(installTurnNavStyles, []);
  React.useEffect(() => { setError(""); setOpened(null); }, [scope, active]);
  const jump = (ownerKey: string): void => {
    if (onJump(ownerKey)) { setCurrent(ownerKey); setOpened(null); setError(""); }
    else setError("这条提问已不在当前载入范围，请重新打开历史导航。");
  };
  if (!active || entries.length < 2) return null;
  return <nav className="turn-nav-dock" data-turn-nav-scope={scope} aria-label="历史提问导航" title={range}>
    <div className="turn-nav-rail">{entries.map(entry => <WandPopover key={entry.ownerKey}
      open={opened === entry.ownerKey} onOpenChange={next => setOpened(next ? entry.ownerKey : null)}
      triggerActions={["hover", "focus", "click"]} side="right" align="center"
      ariaLabel={entry.label} className="turn-nav-popover"
      trigger={<button type="button" className="turn-nav-tick" data-turn-nav-owner={entry.ownerKey}
        aria-label={`${entry.label}：${entry.preview}，回车跳转`} aria-current={entry.ownerKey === current ? "location" : undefined}
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jump(entry.ownerKey); }
        }}>
        <span aria-hidden="true"/>
      </button>}>
      <button type="button" className="turn-nav-summary" onClick={() => jump(entry.ownerKey)}>
        <span className="turn-nav-question">{entry.preview}</span>
        <span className="turn-nav-answer">{entry.reply || "暂无回复摘要"}</span>
        <span className="turn-nav-hint">{entry.label} · 点击跳转</span>
      </button>
    </WandPopover>)}</div>
    {error ? <Typography.Text type="danger" role="status">{error}</Typography.Text> : null}
  </nav>;
}
