import { Tag } from "antd";
import * as React from "react";
import { WandButton, type WandButtonProps } from "./button";
import { WandUiBoundary } from "../theme";
import { classNames } from "./class-names";
export interface WandChipProps extends Omit<WandButtonProps, "size"> {
  size?: "sm" | "md" | "lg";
  variant?: "soft" | "outline" | "primary" | "secondary" | "destructive";
  dismissible?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onDismiss?(): void;
  closeLabel?: string;
}
export function WandChip({ className, size = "md", variant = "soft", dismissible = false, open,
  onOpenChange, onDismiss, closeLabel = "Dismiss", onClick, children, ...props }: WandChipProps) {
  const [internalOpen, setInternalOpen] = React.useState(true);
  const shown = open ?? internalOpen;
  const wasShown = React.useRef(shown);
  React.useEffect(() => {
    if (wasShown.current && !shown) onDismiss?.();
    wasShown.current = shown;
  }, [shown, onDismiss]);
  const kind = props.kind ?? (variant === "destructive" ? "danger" : variant);
  if (!dismissible) return <WandButton {...props} onClick={onClick} kind={kind}
    size={size === "sm" ? "small" : size === "lg" ? "large" : "medium"}
    className={classNames("wand-ui-chip", className)}>{children}</WandButton>;
  if (!shown) return null;
  const dismiss = (): void => { setInternalOpen(false); onOpenChange?.(false); };
  return <WandUiBoundary><Tag className={classNames("wand-ui-chip", className)}
    closeIcon={<span aria-label={closeLabel}>×</span>} closable={!props.disabled}
    color={kind === "primary" ? "var(--accent-solid)" : kind === "danger" ? "error" : undefined}
    onClick={event => { onClick?.(event as unknown as React.MouseEvent<HTMLButtonElement>); if (!props.disabled) dismiss(); }}
    onClose={dismiss}>{children}</Tag></WandUiBoundary>;
}
