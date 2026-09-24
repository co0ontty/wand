import * as React from "react";
import { classNames } from "./class-names";
import { stretchIndicatorFrames, type StretchIndicatorBox } from "./stretch-indicator";

export interface WandStretchTab {
  value: string;
  label: React.ReactNode;
}

export interface WandStretchTabsProps {
  tabs: ReadonlyArray<WandStretchTab>;
  value: string;
  ariaLabel: string;
  className?: string;
  onValueChange(value: string): void;
}

function reduceMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function measureTab(list: HTMLElement, value: string): StretchIndicatorBox | null {
  const button = list.querySelector<HTMLElement>(`[data-stretch-value="${CSS.escape(value)}"]`);
  if (!button) return null;
  return { left: button.offsetLeft, width: button.offsetWidth };
}

export function WandStretchTabs({
  tabs,
  value,
  ariaLabel,
  className,
  onValueChange,
}: WandStretchTabsProps): React.ReactElement {
  const listRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef<StretchIndicatorBox | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const [box, setBox] = React.useState<StretchIndicatorBox | null>(null);
  const signature = tabs.map((tab) => tab.value).join("\0");

  const clearTimer = React.useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const next = measureTab(list, value);
    if (!next) return;
    const frames = stretchIndicatorFrames(frameRef.current, next, reduceMotion());
    frameRef.current = next;
    clearTimer();
    setBox(frames[0] ?? next);
    const settle = frames[1];
    if (!settle) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setBox(settle);
    }, 170);
  }, [clearTimer, signature, value]);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (timerRef.current !== null) return;
      const next = measureTab(list, value);
      if (!next) return;
      frameRef.current = next;
      setBox(next);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [signature, value]);

  React.useEffect(() => clearTimer, [clearTimer]);

  const move = (delta: number): void => {
    const index = Math.max(0, tabs.findIndex((tab) => tab.value === value));
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (!next || next.value === value) return;
    onValueChange(next.value);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-stretch-value="${CSS.escape(next.value)}"]`)
      ?.focus();
  };

  return (
    <div
      ref={listRef}
      className={classNames("wand-stretch-tabs", className)}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {box ? (
        <span
          className="wand-stretch-tabs-indicator"
          style={{ left: box.left, width: box.width }}
          aria-hidden="true"
        />
      ) : null}
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            data-stretch-value={tab.value}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? "is-active" : undefined}
            onClick={() => onValueChange(tab.value)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
