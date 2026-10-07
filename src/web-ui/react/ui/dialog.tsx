import { Flex, Modal, Typography, type ModalProps } from "antd";
import * as React from "react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { WandButton, type WandButtonKind } from "./button";
import { WandInput } from "./input";
import { findDialogFocusTarget, watchDialogAutofocus } from "./dialog-focus";
import { handleDialogOpenChange } from "./dialog-open-change";
import { WandIcon, type WandIconName } from "./icons";
import { usePortalContainer } from "./portal-context";
import { WandUiBoundary } from "../theme";

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
  width?: ModalProps["width"];
  styles?: ModalProps["styles"];
  zIndex?: number;
  className?: string;
  overlayClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  headerClassName?: string;
  closeLabel?: string;
  showClose?: boolean;
  closeContent?: ReactNode;
  testId?: string;
  dismissable?: boolean;
  onOpenChange(open: boolean): void;
  /** Controllers with an explicit return-focus lease settle it after library dismissal. */
  onAfterClose?(): void;
}


const defaultIcons: Record<WandDialogTone, WandIconName> = {
  info: "info", warning: "warning", danger: "warning", success: "check", question: "question",
};

/** Controlled library modal; controllers remain the sole lifecycle owners. */
export function WandDialogSurface({ open, title, description, children, width = 520, styles, zIndex,
  className = "wand-ui-dialog-content", overlayClassName = "wand-ui-dialog-overlay",
  titleClassName = "wand-ui-dialog-title", descriptionClassName = "wand-ui-dialog-description",
  headerClassName = "wand-ui-dialog-heading", closeLabel = "关闭", closeContent = <WandIcon name="close" size={18}/>,
  testId, showClose = true, dismissable = true, onOpenChange, onAfterClose }: WandDialogSurfaceProps) {
  const portal = usePortalContainer();
  const descriptionId = React.useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  const stopDeferredFocus = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (open) openedAt.current = performance.now();
    return () => { stopDeferredFocus.current?.(); stopDeferredFocus.current = null; };
  }, [open]);
  const focus = (): void => {
    stopDeferredFocus.current?.();
    const container = contentRef.current;
    const preferred = findDialogFocusTarget(container, "[data-wand-autofocus]");
    const fallback = findDialogFocusTarget(container, "input, textarea, select, button, [tabindex='0']");
    (preferred ?? fallback)?.focus({ preventScroll: true });
    if (container && !preferred) stopDeferredFocus.current = watchDialogAutofocus(container, fallback);
  };
  return <WandUiBoundary><Modal open={open} centered footer={null} destroyOnHidden
    getContainer={portal ?? undefined} aria-describedby={description ? descriptionId : undefined} keyboard={dismissable} closable={false}
    mask={{ closable: dismissable }} width={width} styles={styles} zIndex={zIndex} focusable={{ focusTriggerAfterClose: !onAfterClose }}
    afterClose={onAfterClose}
    classNames={{ container: className, mask: overlayClassName }}
    onCancel={event => {
      const reason = event.type === "keydown" ? "escape-key" : "outside-press";
      handleDialogOpenChange(false, { reason, cancel() {} }, dismissable, openedAt.current,
        performance.now(), onOpenChange);
    }}
    afterOpenChange={shown => { if (shown) focus(); }}
    modalRender={node => <div ref={contentRef} data-testid={testId} data-wand-dialog-surface="" data-slot="dialog-popup">{node}</div>}
    title={<Flex className={headerClassName} align="flex-start" justify="space-between" gap="small">
      <Flex vertical style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        <Typography.Text className={titleClassName} style={{ fontSize: "inherit", fontWeight: "inherit" }}>{title}</Typography.Text>
        {description && <Typography.Paragraph id={descriptionId} className={descriptionClassName}
          style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: "normal" }}>{description}</Typography.Paragraph>}
      </Flex>
      {showClose && <WandButton kind="ghost" style={{ flexShrink: 0 }} aria-label={closeLabel} disabled={!dismissable} onClick={() => onOpenChange(false)}>{closeContent}</WandButton>}
    </Flex>}>
    {children}
  </Modal></WandUiBoundary>;
}

export function WandDialog<T>({ open, title, description, tone = "info", icon, actions, input,
  dismissable = true, onAction, onDismiss }: WandDialogProps<T>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [inputValue, setInputValue] = useState(input?.value ?? "");
  useEffect(() => {
    if (!open || !input) return;
    const frame = requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    return () => cancelAnimationFrame(frame);
  }, [open, Boolean(input)]);
  const primary = actions.find(action => action.kind === "primary" || action.kind === "danger") ?? actions.at(-1);
  const submit = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || !primary || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault(); onAction(primary.value, inputValue);
  };
  const resolvedIcon = icon == null || ["", "i", "!", "✓", "?"].includes(String(icon))
    ? <WandIcon name={defaultIcons[tone]} size={18}/> : icon;
  return <WandDialogSurface open={open} title={title} description={description} dismissable={dismissable} showClose={false}
    onOpenChange={shown => { if (!shown) onDismiss(); }}>
    <div aria-hidden="true" className="wand-ui-dialog-icon">{resolvedIcon}</div>
    {input && <WandInput ref={inputRef} data-wand-autofocus="true" aria-label={input.label ?? title}
      autoComplete="off" spellCheck={false} placeholder={input.placeholder} value={inputValue}
      onChange={event => setInputValue(event.currentTarget.value)} onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }} onKeyDown={submit}/>}
    <div className="wand-ui-dialog-actions">{actions.map((action, index) => <WandButton
      key={`${action.label}:${index}`} kind={action.kind} data-wand-autofocus={action.autoFocus ? "true" : undefined}
      onClick={() => onAction(action.value, input ? inputValue : undefined)}>{action.label}</WandButton>)}</div>
  </WandDialogSurface>;
}
