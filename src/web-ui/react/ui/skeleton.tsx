import { type ComponentPropsWithoutRef } from "react";
import { classNames } from "./class-names";

export type WandSkeletonProps = ComponentPropsWithoutRef<"span">;

export function WandSkeleton({ className, ...props }: WandSkeletonProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={classNames("wand-ui-skeleton", className)}
    />
  );
}
