import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { WandButton, type WandButtonKind } from "./button";
import { classNames } from "./class-names";
import { usePortalContainer } from "./portal-context";

export type WandDialogTone = "info" | "warning" | "danger" | "success" | "question";

export interface WandDialogAction<T> {
  label: string;
  value: T;
  kind?: WandButtonKind;
  autoFocus?: boolean;
}

export interface WandDialogInput {
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

const defaultIcons: Record<WandDialogTone, ReactNode> = {
  info: "i",
  warning: "!",
  danger: "!",
  success: "✓",
  question: "?",
};

/** Composable feature dialog that keeps Radix, portals and focus inside ui/**. */
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
  closeContent = "×",
  testId,
  dismissable = true,
  onOpenChange,
}: WandDialogSurfaceProps) {
  const portalContainer = usePortalContainer();
  const contentRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || dismissable) onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal container={portalContainer}>
        <DialogPrimitive.Overlay className={overlayClassName} />
        <DialogPrimitive.Content
          ref={contentRef}
          className={className}
          data-testid={testId}
          {...(description ? {} : { "aria-describedby": undefined })}
          onEscapeKeyDown={(event) => { if (!dismissable) event.preventDefault(); }}
          onInteractOutside={(event) => { if (!dismissable) event.preventDefault(); }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
            const target = contentRef.current?.querySelector<HTMLElement>("[data-wand-autofocus]")
              ?? contentRef.current?.querySelector<HTMLElement>("button, input, [tabindex='0']");
            target?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const previous = previouslyFocusedRef.current;
            previouslyFocusedRef.current = null;
            if (previous && document.contains(previous)) previous.focus();
          }}
        >
          <div className={headerClassName}>
            <div>
              <DialogPrimitive.Title className={titleClassName}>{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className={descriptionClassName}>
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <WandButton kind="ghost" aria-label={closeLabel} disabled={!dismissable}>
                {closeContent}
              </WandButton>
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
  const contentRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [inputValue, setInputValue] = useState(input?.value ?? "");

  const primaryAction = actions.find((action) => action.kind === "primary" || action.kind === "danger")
    ?? actions.at(-1);

  function submitPrimary(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || !primaryAction) return;
    event.preventDefault();
    onAction(primaryAction.value, inputValue);
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && dismissable) onDismiss();
      }}
    >
      <DialogPrimitive.Portal container={portalContainer}>
        <DialogPrimitive.Overlay className="wand-ui-dialog-overlay" />
        <DialogPrimitive.Content
          ref={contentRef}
          className="wand-ui-dialog-content"
          {...(description ? {} : { "aria-describedby": undefined })}
          onEscapeKeyDown={(event) => {
            if (!dismissable) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!dismissable) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (inputRef.current) {
              inputRef.current.focus();
              inputRef.current.select();
              return;
            }
            const target = contentRef.current?.querySelector<HTMLElement>("[data-wand-autofocus]")
              ?? contentRef.current?.querySelector<HTMLElement>("button");
            target?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const previous = previouslyFocusedRef.current;
            if (previous && document.contains(previous)) previous.focus();
          }}
        >
          <div className="wand-ui-dialog-header">
            <div
              aria-hidden="true"
              className={classNames("wand-ui-dialog-icon", `wand-ui-dialog-icon-${tone}`)}
            >
              {icon ?? defaultIcons[tone]}
            </div>
            <div className="wand-ui-dialog-heading">
              <DialogPrimitive.Title className="wand-ui-dialog-title">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="wand-ui-dialog-description">
                  {description}
                </DialogPrimitive.Description>
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
