import * as React from "react";

/** Existing Wand mark shared by the shell and its empty state. */
export function WandBrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="18" fill="#17120f"/>
      <path d="M13 21l9 24 10-15 10 15 9-24" fill="none" stroke="#c5653d"
        strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
