import { VOICE_HOLD_DELAY_MS } from "../ui/motion-tokens";

export function idleSpeechEligible(text: string, focused: boolean, keyboardVisible: boolean, mobile: boolean, disabled = false): boolean {
  return mobile && !disabled && text === "" && !focused && !keyboardVisible;
}

export interface IdleSpeechCallbacks {
  enabled(): boolean;
  begin(event: PointerEvent): void;
  move(event: PointerEvent): void;
  finish(event: PointerEvent): void;
  cancel(): void;
}

/** A small native-input adapter, not another text editor or recorder. Editing gestures stay native. */
export function bindIdleSpeechInput(input: HTMLTextAreaElement, callbacks: IdleSpeechCallbacks): { sync(placeholder?: string): void; dispose(): void } {
  let pointer: { id: number; x: number; y: number; event: PointerEvent; started: boolean; moved: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let suppressClick = false;
  let originalPlaceholder = input.placeholder;
  const mobile = (): boolean => window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760;
  const eligible = (): boolean => idleSpeechEligible(input.value, document.activeElement === input,
    document.documentElement.classList.contains("is-keyboard-open"), mobile(), input.disabled || input.readOnly || !callbacks.enabled());
  const stop = (discard: boolean): void => {
    if (timer) clearTimeout(timer); timer = null;
    if (discard && pointer?.started) callbacks.cancel();
    pointer = null;
  };
  const sync = (placeholder?: string): void => {
    if (typeof placeholder === "string") originalPlaceholder = placeholder;
    const enabled = eligible();
    if (!enabled && pointer) stop(true);
    input.toggleAttribute("data-idle-speech", enabled);
    input.placeholder = enabled ? "发消息或按住说话" : originalPlaceholder;
  };
  const down = (event: PointerEvent): void => {
    if (!eligible() || !event.isPrimary || event.button !== 0 || pointer) return;
    event.preventDefault(); event.stopPropagation();
    suppressClick = true;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, event, started: false, moved: false };
    try { input.setPointerCapture(event.pointerId); } catch {}
    timer = setTimeout(() => {
      timer = null;
      if (!pointer || pointer.moved || !eligible()) return;
      pointer.started = true;
      callbacks.begin(pointer.event);
    }, VOICE_HOLD_DELAY_MS);
  };
  const move = (event: PointerEvent): void => {
    if (!pointer || event.pointerId !== pointer.id) return;
    event.preventDefault(); event.stopPropagation();
    if (pointer.started) callbacks.move(event);
    else if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) {
      pointer.moved = true;
      if (timer) clearTimeout(timer); timer = null;
    }
  };
  const up = (event: PointerEvent): void => {
    if (!pointer || event.pointerId !== pointer.id) return;
    event.preventDefault(); event.stopPropagation();
    const captured = pointer;
    stop(false);
    if (captured.started) callbacks.finish(event);
    else if (!captured.moved) input.focus({ preventScroll: true });
    sync();
  };
  const cancelPointer = (event: PointerEvent): void => { if (pointer?.id === event.pointerId) { stop(true); suppressClick = true; } };
  const click = (event: MouseEvent): void => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } };
  const menu = (event: Event): void => { if (pointer?.started) event.preventDefault(); };
  input.addEventListener("pointerdown", down, true); input.addEventListener("pointermove", move, true); input.addEventListener("pointerup", up, true);
  input.addEventListener("pointercancel", cancelPointer, true); input.addEventListener("click", click, true); input.addEventListener("contextmenu", menu);
  const resync = (): void => sync();
  input.addEventListener("focus", resync); input.addEventListener("blur", resync); input.addEventListener("input", resync);
  window.addEventListener("resize", resync);
  sync();
  return { sync, dispose() {
    stop(true);
    input.removeEventListener("pointerdown", down, true); input.removeEventListener("pointermove", move, true); input.removeEventListener("pointerup", up, true);
    input.removeEventListener("pointercancel", cancelPointer, true); input.removeEventListener("click", click, true); input.removeEventListener("contextmenu", menu);
    input.removeEventListener("focus", resync); input.removeEventListener("blur", resync); input.removeEventListener("input", resync);
    window.removeEventListener("resize", resync);
    input.removeAttribute("data-idle-speech"); input.placeholder = originalPlaceholder;
  } };
}
