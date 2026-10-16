import * as React from "react";
import { deferredComponent } from "../deferred-feature.js";
import { classNames } from "../ui/class-names.js";
import type { MarkdownPreviewProps } from "./markdown.js";

/** Keep the canonical parser/renderer out of the cold shell. Reuse the shared
 * request, unmount and explicit-retry lifecycle; text stays readable meanwhile. */
export const DeferredMarkdownPreview = deferredComponent<MarkdownPreviewProps>(
  () => import("./markdown.js").then(module => module.MarkdownPreview),
  { title: "正文排版", renderPending: (status, props, { failed }) => <div aria-busy={!failed}
    className={classNames("wand-markdown-preview", props.variant === "inline" && "wand-markdown-preview-inline", props.wrap && "wrap")}
    style={{ fontSize: props.fontSize == null ? undefined : `${props.fontSize}px`, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
    {props.renderText ? props.renderText(props.content) : props.content}
    {failed ? status : null}
  </div> },
);
