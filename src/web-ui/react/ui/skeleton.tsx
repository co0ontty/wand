import { Skeleton, type SkeletonProps } from "@appica/ui-react/skeleton";
import * as React from "react";
import { classNames } from "./class-names";

export type WandSkeletonProps = SkeletonProps;

export function WandSkeleton({ className, ...props }: WandSkeletonProps) {
  return (
    <Skeleton
      {...props}
      aria-hidden="true"
      className={classNames("wand-ui-skeleton", className)}
    />
  );
}
