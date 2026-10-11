import * as React from "react";
import { Spin } from "antd";
import { installStyleSheet } from "../styles.js";
import { useReducedMotion } from "../ui/motion-tokens.js";

/** Decorative thought orbit; execution state is announced in the adjacent text. */
export function AvatarThinking(): React.ReactElement {
  const reduced = useReducedMotion();
  React.useLayoutEffect(() => installStyleSheet("wand-avatar-thinking", `
.wand-avatar-thinking{position:absolute;left:var(--plush-thinking-x,4px);top:var(--plush-thinking-y,0px);transform:translate(-50%,-50%);z-index:2;line-height:0;color:var(--text-secondary);pointer-events:none}
.wand-avatar-thinking .ant-spin{display:block;color:inherit;line-height:0}
.wand-avatar-thinking .ant-spin-dot{font-size:24px}
.wand-avatar-thinking .ant-spin-dot-spin{animation-duration:var(--motion-spin)}
.wand-avatar-thinking[data-reduced-motion="true"] .ant-spin-dot-spin{animation:none}
.wand-plush-avatar[data-render-state="paused"] .ant-spin-dot-spin{animation-play-state:paused}
`), []);
  return <span className="wand-avatar-thinking" data-reduced-motion={reduced} aria-hidden="true">
    <Spin size="small" indicator={<svg className="ant-spin-dot-spin" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="var(--bg-primary)" strokeWidth="0.6">
      {[1, 0.9, 0.75, 0.6, 0.45, 0.3, 0.2, 0.15].map((opacity, index) =>
        <rect key={index} x="10.5" y="1" width="3" height="6" rx="1.5" opacity={opacity} transform={`rotate(${index * 45} 12 12)`}/>
      )}
    </svg>}/>
  </span>;
}
