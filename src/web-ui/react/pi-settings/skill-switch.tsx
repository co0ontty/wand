import * as React from "react";
import { Segmented } from "antd";
import { WandIcon } from "../ui";
import type { PiSkillMode } from "../../../pi-session-settings.js";

const MODES: PiSkillMode[] = ["off", "on", "locked"];
const LABELS = ["关闭", "开启", "开启并锁定"];

/** One gesture, one atomic save. The middle detent reveals the final lock position. */
export function PiSkillSwitch({ name, mode, disabled, onModeChange }: {
  name: string; mode: PiSkillMode; disabled: boolean; onModeChange(mode: PiSkillMode): Promise<boolean>;
}): React.ReactElement {
  const [preview, setPreview] = React.useState<number | null>(null);
  const pointer = React.useRef<number | null>(null);
  const pending = React.useRef(false);
  const index = preview ?? MODES.indexOf(mode);
  const unavailable = disabled || pending.current;
  const position = (event: React.PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(2, Math.floor((event.clientX - rect.left) / rect.width * 3)));
  };
  const cancel = (): void => { pointer.current = null; setPreview(null); };
  async function commit(next: number): Promise<void> {
    if (pending.current || disabled) { cancel(); return; }
    if (MODES[next] === mode) { setPreview(null); return; }
    pending.current = true; setPreview(next);
    try { await onModeChange(MODES[next]!); }
    finally { pending.current = false; setPreview(null); }
  }
  React.useEffect(() => {
    if (disabled && pointer.current !== null) cancel();
  }, [disabled]);
  return <div className="wand-pi-skill-switch" style={{ width: 114, flexShrink: 0, touchAction: "pan-y", userSelect: "none", direction: "ltr" }} role="slider" tabIndex={unavailable ? -1 : 0}
    aria-label={`Skill ${name} 使用设置`} aria-valuemin={0} aria-valuemax={2}
    aria-valuenow={index} aria-valuetext={LABELS[index]} aria-disabled={unavailable}
    data-mode={MODES[index]} data-dragging={pointer.current !== null}
    title="右滑：关 → 开 → 开并锁定；左滑回开解锁"
    onPointerDown={(event) => {
      if (unavailable || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId);
      setPreview(position(event));
    }}
    onPointerMove={(event) => { if (pointer.current === event.pointerId) setPreview(position(event)); }}
    onPointerUp={(event) => {
      if (pointer.current !== event.pointerId) return;
      pointer.current = null;
      void commit(position(event));
    }}
    onPointerCancel={cancel}
    onLostPointerCapture={() => { if (pointer.current !== null) cancel(); }}
    onKeyDown={(event) => {
      if (unavailable) return;
      const next = event.key === "ArrowRight" || event.key === "ArrowUp" ? Math.min(2, index + 1)
        : event.key === "ArrowLeft" || event.key === "ArrowDown" ? Math.max(0, index - 1)
          : event.key === "Home" ? 0 : event.key === "End" ? 2 : null;
      if (next === null) return;
      event.preventDefault(); event.stopPropagation(); void commit(next);
    }}>
    <div aria-hidden="true" inert style={{ pointerEvents: "none" }}>
      <Segmented block size="small" value={MODES[index]} disabled={unavailable}
        options={[{ value: "off", label: "关" }, { value: "on", label: "开" },
          { value: "locked", label: <span className="wand-pi-skill-switch-lock" style={{ visibility: index === 0 ? "hidden" : undefined }}><WandIcon name={index === 2 ? "lock" : "unlock"} size={15}/></span> }]}/>
    </div>
  </div>;
}
