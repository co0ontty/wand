import { Skeleton } from "antd";
import * as React from "react";
import { classNames } from "./class-names";
import { WandUiBoundary } from "../theme";
export type WandSkeletonProps = React.ComponentPropsWithRef<"div"> & { effect?: "shimmer" | "pulse" | "none" };
export function WandSkeleton({ className, effect = "shimmer", ...props }: WandSkeletonProps) {
  return <WandUiBoundary><div {...props} aria-hidden="true" className={classNames("wand-ui-skeleton", className)}>
    <Skeleton.Input active={effect !== "none"} block size="small"/>
  </div></WandUiBoundary>;
}
