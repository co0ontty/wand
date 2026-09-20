import {
  Dialog as AppicaDialog,
  DialogClose as AppicaDialogClose,
  DialogContent as AppicaDialogContent,
  DialogDescription as AppicaDialogDescription,
  DialogTitle as AppicaDialogTitle,
} from "@appica/ui-react/dialog";
import * as React from "react";
import { type ComponentProps, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { WandButton, type WandButtonKind } from "./button";
import { classNames } from "./class-names";
import { findDialogFocusTarget, watchDialogAutofocus } from "./dialog-focus";
import { WandIcon, type WandIconName } from "./icons";
import { usePortalContainer } from "./portal-context";

export type WandDialogTone = "info" | "warning" | "danger" | "success" | "question";

interface WandDialogAction<T> {
  label: string;
  value: T;
  kind?: WandButtonKind;
  autoFocus?: boolean;
}

interface WandDialogInput {
  value?: string;
  placeholder?: string;
  label?: string;
}

export interface WandDialogProps<T> {
  open: boolean;
  title: string;
  description?: string;
  tone?: WandDialogTone;
  icon?: ReactNode;
  actions: ReadonlyArray<WandDialogAction<T>>;
  input?: WandDialogInput;
  dismissable?: boolean;
  onAction(value: T, inputValue?: string): void;
  onDismiss(): void;
}

export interface WandDialogSurfaceProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  overlayClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  headerClassName?: string;
  closeLabel?: string;
  closeContent?: ReactNode;
  testId?: string;
  dismissable?: boolean;
  onOpenChange(open: boolean): void;
}

const defaultIcons: Record<WandDialogTone, WandIconName> = {
  info: "info",
  warning: "warning",
  danger: "warning",
  success: "check",
  question: "question",
};

type AppicaDialogOpenChange = NonNullable<ComponentProps<typeof AppicaDialog>["onOpenChange"]>;
type AppicaDialogChangeDetails = Parameters<AppicaDialogOpenChange>[1];

/**
 * A locked dialog (`dismissable={false}`) must survive Escape and outside
 * presses. Base UI reports every close attempt through `onOpenChange` with a
 * reason, so the attempt is cancelled instead of relying on per-event handlers.
 */
function makeOpenChangeHandler(dismissable: boolean, onOpenChange: (open: boolean) => void) {
  return (nextOpen: boolean, details: AppicaDialogChangeDetails): void => {
    if (!nextOpen && !dismissable) {
      if (details.reason === "escape-key" || details.reason === "outside-press") {
        details.cancel();
        return;
      }
    }
    onOpenChange(nextOpen);
  };
}

function resolveDialogIcon(tone: WandDialogTone, icon?: ReactNode): ReactNode {
  if (icon == null || icon === "" || icon === "i" || icon === "!" || icon === "✓" || icon === "?") {
    return <WandIcon name={defaultIcons[tone]} size={18} strokeWidth={1.8} />;
  }
  return icon;
}

/** `true` hands the choice back to Base UI (first tabbable in the popup). */
function firstTabbable(container: HTMLElement | null, selector: string): HTMLElement | true {
  // A comma-separated selector follows DOM order, not selector priority. Look
  // for the caller's explicit target before the header's close button.
  return findDialogFocusTarget(container, "[data-wand-autofocus]")
    ?? findDialogFocusTarget(container, selector)
    ?? true;
}

/** Composable feature dialog rendered by Appica's dialog parts, portalled under `ui/`. */
export function WandDialogSurface({
  open,
  title,
  description,
  children,
  className = "wand-ui-dialog-content",
  overlayClassName = "wand-ui-dialog-overlay",
  titleClassName = "wand-ui-dialog-title",
  descriptionClassName = "wand-ui-dialog-description",
  headerClassName = "wand-ui-dialog-heading",
  closeLabel = "关闭",
  closeContent = <WandIcon name="close" size={18}/>,
  testId,
  dismissable = true,
  onOpenChange,
}: WandDialogSurfaceProps) {
  const portalContainer = usePortalContainer();
  const contentRef = useRef<HTMLDivElement>(null);
  const stopDeferredFocus = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!open) return;
    return () => {
      stopDeferredFocus.current?.();
      stopDeferredFocus.current = null;
    };
  }, [open]);

  function initialFocus(): HTMLElement | true {
    stopDeferredFocus.current?.();
    const container = contentRef.current;
    const preferred = findDialogFocusTarget(container, "[data-wand-autofocus]");
    if (preferred) return preferred;
    const fallback = findDialogFocusTarget(container, "button, input, textarea, select, [tabindex='0']");
    if (container) stopDeferredFocus.current = watchDialogAutofocus(container, fallback);
    return fallback ?? true;
  }

  return (
    <AppicaDialog open={open} onOpenChange={makeOpenChangeHandler(dismissable, onOpenChange)}>
      <AppicaDialogContent
        ref={contentRef}
        container={portalContainer}
        className={className}
        backdrop
        frame={false}
        closeButton={false}
        data-testid={testId}
        backdropProps={{ className: overlayClassName }}
        viewportProps={{ className: "wand-ui-dialog-viewport" }}
        initialFocus={initialFocus}
      >
        <div className={headerClassName}>
          <div>
            <AppicaDialogTitle className={titleClassName}>{title}</AppicaDialogTitle>
            {description ? (
              <AppicaDialogDescription className={descriptionClassName}>
                {description}
              </AppicaDialogDescription>
            ) : null}
          </div>
          <AppicaDialogClose
            render={
              <WandButton kind="ghost" aria-label={closeLabel} disabled={!dismissable}>
                {closeContent}
              </WandButton>
            }
          />
        </div>
        {children}
      </AppicaDialogContent>
    </AppicaDialog>
  );
}

export function WandDialog<T>({
  open,
  title,
  description,
  tone = "info",
  icon,
  actions,
  input,
  dismissable = true,
  onAction,
  onDismiss,
}: WandDialogProps<T>) {
  const portalContainer = usePortalContainer();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputComposing = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState(input?.value ?? "");
  const hasInput = Boolean(input);

  useEffect(() => {
    if (!open || !hasInput) return;
    // Base UI 在自身 layout effect 里聚焦 initialFocus 目标，所以选中要等一帧后再做，
    // 否则随后的 focus() 会把选区收回光标位置。
    const frame = requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      node.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, hasInput]);

  const primaryAction = actions.find((action) => action.kind === "primary" || action.kind === "danger")
    ?? actions.at(-1);

  function submitPrimary(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || !primaryAction || inputComposing.current
      || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    onAction(primaryAction.value, inputValue);
  }

  return (
    <AppicaDialog
      open={open}
      onOpenChange={makeOpenChangeHandler(dismissable, (nextOpen) => {
        if (!nextOpen) onDismiss();
      })}
    >
      <AppicaDialogContent
        ref={contentRef}
        container={portalContainer}
        className="wand-ui-dialog-content"
        backdrop
        frame={false}
        closeButton={false}
        backdropProps={{ className: "wand-ui-dialog-overlay" }}
        viewportProps={{ className: "wand-ui-dialog-viewport" }}
        initialFocus={() =>
          inputRef.current
          ?? firstTabbable(contentRef.current, "button")}
      >
        <div className="wand-ui-dialog-header">
          <div
            aria-hidden="true"
            className={classNames("wand-ui-dialog-icon", `wand-ui-dialog-icon-${tone}`)}
          >
            {resolveDialogIcon(tone, icon)}
          </div>
          <div className="wand-ui-dialog-heading">
            <AppicaDialogTitle className="wand-ui-dialog-title">
              {title}
            </AppicaDialogTitle>
            {description ? (
              <AppicaDialogDescription className="wand-ui-dialog-description">
                {description}
              </AppicaDialogDescription>
            ) : null}
          </div>
        </div>

        {input ? (
          <div className="wand-ui-dialog-body">
            <input
              ref={inputRef}
              className="wand-ui-dialog-input"
              type="text"
              aria-label={input.label ?? title}
              autoComplete="off"
              spellCheck={false}
              placeholder={input.placeholder}
              value={inputValue}
              onChange={(event) => setInputValue(event.currentTarget.value)}
              onCompositionStart={() => { inputComposing.current = true; }}
              onCompositionEnd={() => { inputComposing.current = false; }}
              onKeyDown={submitPrimary}
            />
          </div>
        ) : null}

        <div className="wand-ui-dialog-actions">
          {actions.map((action, index) => (
            <WandButton
              key={`${action.label}-${index}`}
              kind={action.kind}
              data-wand-autofocus={action.autoFocus ? "true" : undefined}
              onClick={() => onAction(action.value, input ? inputValue : undefined)}
            >
              {action.label}
            </WandButton>
          ))}
        </div>
      </AppicaDialogContent>
    </AppicaDialog>
  );
}
