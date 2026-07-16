import type {
  OverlayDialogOptions,
  OverlayDialogResult,
  OverlayToastOptions,
  WandOverlay,
} from "./overlay-controller";
import type { WandButtonKind, WandDialogTone, WandToastTone } from "./ui";

interface LegacyDialogButton {
  label?: unknown;
  value?: unknown;
  kind?: unknown;
  autofocus?: unknown;
  autoFocus?: unknown;
}

export interface LegacyDialogOptions {
  title?: unknown;
  message?: unknown;
  type?: unknown;
  icon?: unknown;
  buttons?: LegacyDialogButton[];
  input?: unknown;
  inputValue?: unknown;
  inputPlaceholder?: unknown;
  inputLabel?: unknown;
  cancelValue?: unknown;
  dismissable?: unknown;
}

interface LegacyDialogActionToken {
  button: LegacyDialogButton;
}

let pendingReactLegacyDialogs = 0;
let reactLegacyFocusOrigin: HTMLElement | null = null;
let reactLegacyFocusRestoreScheduled = false;

function activeOverlay(): WandOverlay | null {
  const overlay = window.__wandReactUi;
  if (!overlay || typeof overlay.dialog !== "function" || typeof overlay.toast !== "function") {
    return null;
  }
  return overlay;
}

function dialogTone(value: unknown): WandDialogTone {
  switch (value) {
    case "warning":
    case "danger":
    case "success":
    case "question":
      return value;
    case "error":
      return "danger";
    default:
      return "info";
  }
}

function toastTone(value: unknown): WandToastTone {
  switch (value) {
    case "success":
    case "warning":
    case "error":
      return value;
    default:
      return "info";
  }
}

function buttonKind(value: unknown): WandButtonKind {
  switch (value) {
    case "primary":
    case "outline":
    case "ghost":
    case "danger":
      return value;
    default:
      return "secondary";
  }
}

function dialogButtons(options: LegacyDialogOptions): LegacyDialogButton[] {
  return Array.isArray(options.buttons) && options.buttons.length > 0
    ? options.buttons
    : [{ label: "好", value: true, kind: "primary", autofocus: true }];
}

function cancelResult(options: LegacyDialogOptions): unknown {
  if (options.cancelValue !== undefined) return options.cancelValue;
  return options.input ? null : false;
}

function readFocusOrigin(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement as HTMLElement | null;
  return active && typeof active.focus === "function" ? active : null;
}

function scheduleFocusRestore(): void {
  if (reactLegacyFocusRestoreScheduled) return;
  reactLegacyFocusRestoreScheduled = true;
  const schedule = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);
  schedule(() => {
    reactLegacyFocusRestoreScheduled = false;
    if (pendingReactLegacyDialogs > 0) return;
    const target = reactLegacyFocusOrigin;
    reactLegacyFocusOrigin = null;
    if (!target || !target.isConnected || typeof document === "undefined" || !document.contains(target)) return;
    try { target.focus(); } catch { /* The legacy target may have disappeared during a full render. */ }
  });
}

function finishReactLegacyDialog(): void {
  pendingReactLegacyDialogs = Math.max(0, pendingReactLegacyDialogs - 1);
  if (pendingReactLegacyDialogs === 0) scheduleFocusRestore();
}

/**
 * Routes the legacy dialog contract through the mounted React/Radix host.
 * `null` means that the host is disabled or unavailable and the caller must
 * use its DOM fallback. Button tokens retain the original value/kind so prompt
 * submission has exactly the same return semantics as the legacy dialog.
 */
export function openReactLegacyDialog(options: LegacyDialogOptions): Promise<unknown> | null {
  const overlay = activeOverlay();
  if (!overlay) return null;

  const focusAtOpen = pendingReactLegacyDialogs === 0 && !reactLegacyFocusRestoreScheduled
    ? readFocusOrigin()
    : null;

  const buttons = dialogButtons(options);
  const tone = dialogTone(options.type);
  const hasInput = !!options.input;
  const reactOptions: OverlayDialogOptions<LegacyDialogActionToken> = {
    title: options.title
      ? String(options.title)
      : tone === "danger" ? "确认操作" : "提示",
    description: options.message ? String(options.message) : undefined,
    tone,
    icon: options.icon == null ? undefined : String(options.icon),
    actions: buttons.map((button) => ({
      label: button.label == null ? "" : String(button.label),
      value: { button },
      kind: buttonKind(button.kind),
      autoFocus: button.autofocus === true || button.autoFocus === true,
    })),
    input: hasInput ? {
      value: options.inputValue == null ? "" : String(options.inputValue),
      placeholder: options.inputPlaceholder == null ? undefined : String(options.inputPlaceholder),
      label: options.inputLabel == null
        ? (options.title == null ? "输入内容" : String(options.title))
        : String(options.inputLabel),
    } : undefined,
    dismissable: options.dismissable !== false,
  };

  let result: Promise<OverlayDialogResult<LegacyDialogActionToken>>;
  try {
    result = overlay.dialog(reactOptions);
  } catch {
    return null;
  }

  if (pendingReactLegacyDialogs === 0 && !reactLegacyFocusRestoreScheduled) {
    reactLegacyFocusOrigin = focusAtOpen;
  }
  pendingReactLegacyDialogs += 1;

  return result
    .then((outcome) => {
      if (outcome.dismissed === true) return cancelResult(options);
      const button = outcome.action.button;
      if (hasInput && buttonKind(button.kind) === "primary") {
        return outcome.inputValue ?? "";
      }
      return button.value;
    })
    .finally(finishReactLegacyDialog);
}

/** Returns false when the React host is disabled/unavailable. */
export function showReactLegacyToast(message: string, type: unknown, duration: number): boolean {
  const overlay = activeOverlay();
  if (!overlay) return false;

  const options: OverlayToastOptions = {
    tone: toastTone(type),
    duration,
  };
  try {
    overlay.toast(message, options);
    return true;
  } catch {
    return false;
  }
}
