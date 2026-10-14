import * as React from "react";
import { WandButton } from "../ui/index.js";

export function PtyModifierButtons({ ctrl, shift, disabled, onToggle }: {
  ctrl: boolean; shift: boolean; disabled?: boolean; onToggle(key: "ctrl" | "shift"): void;
}): React.ReactElement {
  return <div className="pty-modifier-buttons" role="group" aria-label="持续组合键">
    {(["ctrl", "shift"] as const).map(key => {
      const pressed = key === "ctrl" ? ctrl : shift;
      const label = key === "ctrl" ? "Ctrl" : "Shift";
      return <WandButton key={key} className="pty-modifier-toggle" kind="soft" data-modifier={key} aria-pressed={pressed}
        aria-label={`${label} ${pressed ? "已持续开启，再点关闭" : "点击持续开启"}`} title={`${label} ${pressed ? "已持续开启，再点关闭" : "点击持续开启，可与字母和方向键组合"}`}
        disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => onToggle(key)}>{label}</WandButton>;
    })}
  </div>;
}
