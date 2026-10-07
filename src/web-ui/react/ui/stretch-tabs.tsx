import * as React from "react";
import { Segmented } from "antd";
import { WandUiBoundary } from "../theme";
import { classNames } from "./class-names";
import { useReducedMotion } from "./motion-tokens";
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

function measureTab(list: HTMLElement, value: string): StretchIndicatorBox | null {
  const button = list.querySelector<HTMLElement>(`[data-stretch-value="${CSS.escape(value)}"]`)?.closest<HTMLElement>(".ant-segmented-item");
  if (!button) return null;
  return { left: button.offsetLeft, width: button.offsetWidth };
}

/** Completion is accepted only for the current visible target, never an obsolete event. */
export function stretchIndicatorReached(actual: StretchIndicatorBox, target: StretchIndicatorBox): boolean {
  return Math.abs(actual.left - target.left) < 1 && Math.abs(actual.width - target.width) < 1;
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
  const indicatorRef = React.useRef<HTMLSpanElement>(null);
  const settleRef = React.useRef<StretchIndicatorBox | null>(null);
  const reduced = useReducedMotion();
  const [box, setBox] = React.useState<StretchIndicatorBox | null>(null);
  const signature = tabs.map((tab) => tab.value).join("\0");

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const next = measureTab(list, value);
    if (!next) return;
    const indicator = indicatorRef.current;
    // On rapid changes start from the visible frame, not the previous destination.
    const previous = indicator && frameRef.current
      ? { left: indicator.offsetLeft, width: indicator.offsetWidth } : frameRef.current;
    const frames = stretchIndicatorFrames(previous, next, reduced);
    frameRef.current = next;
    settleRef.current = frames[1] ?? null;
    setBox(frames[0] ?? next);
    if (indicator && frames[1] && stretchIndicatorReached(
      { left: indicator.offsetLeft, width: indicator.offsetWidth }, frames[0],
    )) {
      // Already fully stretched (e.g. reversing mid-flight): no transition will fire.
      settleRef.current = null;
      setBox(next);
    }
  }, [reduced, signature, value]);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (settleRef.current) return;
      const next = measureTab(list, value);
      if (!next) return;
      frameRef.current = next;
      setBox(next);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [signature, value]);

  return (
    <WandUiBoundary><div
      ref={listRef}
      className={classNames("wand-ui-stretch-tabs", className)}
      onKeyDown={event => {
        if (event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const next = tabs[event.key === "Home" ? 0 : tabs.length - 1];
        if (!next) return;
        onValueChange(next.value);
        listRef.current?.querySelector(`[data-stretch-value="${CSS.escape(next.value)}"]`)
          ?.closest(".ant-segmented-item")?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
      }}
    >
      {box ? (
        <span
          ref={indicatorRef}
          className="wand-ui-stretch-indicator"
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget || !box || reduced) return;
            if (event.propertyName !== "left" && event.propertyName !== "width") return;
            const indicator = event.currentTarget;
            // An obsolete completion cannot advance a newer target's stretch phase.
            if (!stretchIndicatorReached(
              { left: indicator.offsetLeft, width: indicator.offsetWidth }, box,
            )) return;
            const settle = settleRef.current;
            if (!settle) return;
            settleRef.current = null;
            setBox(settle);
          }}
          style={{ left: box.left, width: box.width }}
          aria-hidden="true"
        />
      ) : null}
      <Segmented value={value} onChange={onValueChange} aria-label={ariaLabel}
        options={tabs.map(tab => ({ value: tab.value, label: <span data-stretch-value={tab.value}>{tab.label}</span> }))}/>
    </div></WandUiBoundary>
  );
}
