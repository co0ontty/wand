import * as React from "react";
import type { AvatarFileActivity } from "../../composer-avatar-activity.js";

/** Static, recognizable desk props while WebGL is loading or unavailable. */
export function AvatarFilePropsFallback({ activity, pawColor }: { activity: AvatarFileActivity; pawColor: string }): React.ReactElement | null {
  if (activity === "idle") return null;
  return <svg className="wand-avatar-file-fallback" viewBox="0 0 100 100" aria-hidden="true" data-file-prop={activity}>
    {activity === "reading" ? <>
      <path d="M25 70Q38 67 50 73Q62 67 75 70V90Q62 87 50 93Q38 87 25 90Z" fill="#426a70"/>
      <path d="M25 71Q38 69 50 74Q62 69 75 71L74 74Q61 71 50 77Q39 71 26 74Z" fill="#fff3d5"/>
      <circle cx="25" cy="84" r="4.2" fill={pawColor}/><circle cx="75" cy="84" r="4.2" fill={pawColor}/>
      <path d="M50 77v15m-20-14 1 9m38-9-1 9" stroke="#dba758" strokeWidth="1"/>
    </> : <>
      <path d="M28 75L70 72L74 92L31 95Z" fill="#426a70"/>
      <path d="M31 76L68 74L70 76L32 78Z" fill="#fff3d5"/>
      <path d="M34 78l2 12" stroke="#626c78" strokeWidth="1"/>
      <path d="M53 77L59 66" stroke="#dba758" strokeWidth="3" strokeLinecap="round"/>
      <path d="M53 77L51 79L55 78Z" fill="#626c78"/>
      <circle cx="30" cy="86" r="4.2" fill={pawColor}/><circle cx="56" cy="72" r="4" fill={pawColor}/>
    </>}
  </svg>;
}
