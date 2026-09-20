import * as React from "react";
import { WAND_BRAND } from "../../brand-logo-data.js";

/** Android's pixel-cat mark shared by the shell and its empty state. */
export function WandBrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox={`0 0 ${WAND_BRAND.viewport} ${WAND_BRAND.viewport}`}
      aria-hidden="true" focusable="false" data-wand-brand="pixel-cat">
      <rect width={WAND_BRAND.viewport} height={WAND_BRAND.viewport} rx="24" fill={WAND_BRAND.background}/>
      <g transform={`translate(${WAND_BRAND.inset} ${WAND_BRAND.inset})`}>
        {WAND_BRAND.paths.map(({ fill, d }) => <path key={fill} fill={fill} d={d}/>)}
      </g>
    </svg>
  );
}
