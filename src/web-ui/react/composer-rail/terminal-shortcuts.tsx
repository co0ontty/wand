import * as React from "react";
import { Button, Flex } from "../design-library";

const shortcuts = [
  { key: "escape", label: "Esc", title: "Escape" },
  { key: "tab", label: "Tab", title: "Tab" },
  { key: "shift_tab", label: "Shift+Tab", title: "Shift+Tab" },
  { key: "ctrl_c", label: "Ctrl+C", title: "Ctrl+C · 中断" },
  { key: "up", label: "↑", title: "方向键上" },
  { key: "down", label: "↓", title: "方向键下" },
  { key: "left", label: "←", title: "方向键左" },
  { key: "right", label: "→", title: "方向键右" },
  { key: "enter", label: "Enter", title: "发送回车" },
];

/** Shared native geometry; creation measurement supplies no dispatch callback. */
export function TerminalShortcutsChrome({ disabled, onKey }: { disabled: boolean; onKey?: (key: string) => void }): React.ReactElement {
  return <Flex gap="small" wrap={false} role="group" aria-label="PTY 快捷键" className="terminal-shortcuts-row">
    {shortcuts.map(({ key, label, title }) => <Button
      key={key} data-terminal-key={key} disabled={disabled} title={title} aria-label={title}
      // Keep the input/IME focused on pointer activation. Do not cancel touch
      // pointerdown: horizontal panning must still reach the overflow container.
      onMouseDown={event => { if (event.button === 0) event.preventDefault(); }}
      onClick={() => onKey?.(key)}
    >{label}</Button>)}
  </Flex>;
}
