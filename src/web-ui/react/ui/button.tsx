import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { classNames } from "./class-names";

export type WandButtonKind = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type WandButtonSize = "small" | "medium" | "large";

export interface WandButtonProps extends ComponentPropsWithoutRef<"button"> {
  kind?: WandButtonKind;
  size?: WandButtonSize;
}

export const WandButton = forwardRef<HTMLButtonElement, WandButtonProps>(function WandButton(
  { className, kind = "secondary", size = "medium", type = "button", ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classNames(
        "wand-ui-button",
        `wand-ui-button-${kind}`,
        size !== "medium" && `wand-ui-button-${size}`,
        className,
      )}
    />
  );
});
