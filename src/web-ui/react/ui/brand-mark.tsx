import * as React from "react";
import { WAND_BRAND } from "../../brand-logo-data.js";

/** Android's pixel-cat mark shared by the shell and its empty state. */
export function WandBrandMark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={{ width: 24, height: 24, flexShrink: 0, ...style }} viewBox={`0 0 ${WAND_BRAND.viewport} ${WAND_BRAND.viewport}`}
      aria-hidden="true" focusable="false" data-wand-brand="pixel-cat">
      <rect width={WAND_BRAND.viewport} height={WAND_BRAND.viewport} rx="24" fill={WAND_BRAND.background}/>
      <g transform={`translate(${WAND_BRAND.inset} ${WAND_BRAND.inset})`}>
        {WAND_BRAND.paths.map(({ fill, d }) => <path key={fill} fill={fill} d={d}/>)}
      </g>
    </svg>
  );
}
