import * as React from "react";
import { createPortal } from "react-dom";
import { Button, Flex } from "../design-library";
import { WandButton } from "../ui/button.js";
import { WandIcon } from "../ui/icons.js";
import { WandPopover } from "../ui/popover.js";
import { ptyInputState } from "../../pty-input-state.js";

/** Priority is stable; resizing shows the largest prefix that fits. */
export const PTY_SHORTCUTS = [
  { key: "enter", label: "Enter", title: "发送回车" },
  { key: "up", label: "↑", title: "方向键上" },
  { key: "down", label: "↓", title: "方向键下" },
  { key: "left", label: "←", title: "方向键左" },
  { key: "right", label: "→", title: "方向键右" },
  { key: "escape", label: "Esc", title: "Escape" },
  { key: "tab", label: "Tab", title: "Tab" },
  { key: "ctrl_c", label: "Ctrl+C", title: "Ctrl+C · 中断" },
  { key: "home", label: "Home", title: "行首" },
  { key: "end", label: "End", title: "行尾" },
  { key: "backspace", label: "⌫", title: "退格" },
  { key: "delete", label: "Del", title: "删除后一字符" },
  { key: "pageup", label: "PgUp", title: "上一页" },
  { key: "pagedown", label: "PgDn", title: "下一页" },
];

export function fittingShortcutCount(available: number, widths: readonly number[], gap: number): number {
  let used = 0, count = 0;
  for (const width of widths) {
    const next = used + (count ? gap : 0) + width;
    if (next > available + .5) break;
    used = next; count++;
  }
  return count;
}

/** The original input owner handles dispatch; hidden keys retain their place in the priority list. */
export function TerminalShortcutsChrome({ disabled, onKey, owner = "" }: {
  disabled: boolean; onKey?: (key: string) => void; owner?: string;
}): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null), probe = React.useRef<HTMLDivElement>(null);
  const [count, setCount] = React.useState(PTY_SHORTCUTS.length);
  const [moreHost, setMoreHost] = React.useState<HTMLElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const moreTrigger = React.useRef<HTMLButtonElement>(null);
  const snapshot = React.useSyncExternalStore(ptyInputState.subscribe, () => ptyInputState.read(owner), () => ptyInputState.read(owner));
  React.useEffect(() => { if (snapshot.mode !== "shortcuts" || disabled) setOpen(false); }, [snapshot.mode, disabled]);
  React.useEffect(() => { setOpen(false); }, [owner]);
  React.useLayoutEffect(() => {
    const root = host.current, measure = probe.current;
    if (!root || !measure) return;
    const refresh = (): void => {
      const width = root.clientWidth;
      if (!width) return;
      const gap = parseFloat(getComputedStyle(root).columnGap) || 0;
      const widths = Array.from(measure.querySelectorAll("button"), button => button.getBoundingClientRect().width);
      if (widths.every(value => value > 0)) setCount(fittingShortcutCount(width, widths, gap));
    };
    refresh();
    const observer = new ResizeObserver(refresh); observer.observe(root); observer.observe(measure);
    let active = true;
    void document.fonts.ready.then(() => { if (active) refresh(); });
    setMoreHost(owner ? root.closest(".input-composer")?.querySelector<HTMLElement>("[data-pty-extra-keys-host]") ?? null : null);
    return () => { active = false; observer.disconnect(); };
  }, [owner]);
  const remaining = PTY_SHORTCUTS.slice(count);
  return <>
    <Flex ref={host} gap={4} wrap={false} role="group" aria-label="PTY 快捷键" className="terminal-shortcuts-row">
      {PTY_SHORTCUTS.map(({ key, label, title }, index) => <Button key={key} data-terminal-key={key} hidden={index >= count}
        disabled={disabled} title={title} aria-label={title}
        onMouseDown={event => { if (event.button === 0) event.preventDefault(); }} onClick={() => onKey?.(key)}>{label}</Button>)}
      <div className="terminal-shortcuts-measure" aria-hidden="true" inert>
        <Flex ref={probe} gap={4} wrap={false} className="terminal-shortcuts-row terminal-shortcuts-probe">
          {PTY_SHORTCUTS.map(({ key, label }) => <Button key={key} tabIndex={-1}>{label}</Button>)}
        </Flex>
      </div>
    </Flex>
    {moreHost ? createPortal(<WandPopover side="top" ariaLabel="其他终端按键" popupOwner={`pty-extra-keys-${owner}`}
      open={open} onOpenChange={setOpen} trigger={<WandButton ref={moreTrigger} className="pty-extra-keys-trigger" kind="soft"
        aria-label="更多终端按键" title="更多终端按键" disabled={disabled || !remaining.length} aria-expanded={open}
        style={{ visibility: remaining.length ? undefined : "hidden" }}>
        <WandIcon name="more" size={18}/></WandButton>}>
      <div className="pty-extra-keys-grid" role="group" aria-label="未显示的终端按键">
        {remaining.map(({ key, label, title }) => <WandButton key={key} title={title} aria-label={title} data-extra-terminal-key={key}
          onClick={() => { onKey?.(key); setOpen(false); moreTrigger.current?.focus({preventScroll:true}); }}>{label}</WandButton>)}
      </div>
    </WandPopover>, moreHost) : null}
  </>;
}
