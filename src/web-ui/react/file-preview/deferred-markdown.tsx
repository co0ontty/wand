import * as React from "react";
import { deferredComponent } from "../deferred-feature.js";
import { classNames } from "../ui/class-names.js";
import type { MarkdownPreviewProps } from "./markdown.js";

/**
 * 首帧占位必须与最终正文同构。
 *
 * 之前占位把整段原文当裸文本塞进容器，真正的 Markdown 渲染器到达后同一段文字变成
 * `<p>`（还带 `margin-block:0 16px`），于是每一行回复都长高 16px。实测聊天冷加载
 * 那次 0.519 的布局位移就是 184 条回复同时从 102px 变成 118px（其中首条从 666px
 * 的整屏占位收成 118px）。
 *
 * 这里按 Markdown 的段落语义先切块：空行分段，段内软换行保持同一段。占位与正式渲染
 * 因此共用「段落数 × 段间距 + 行高」这套几何，解析器晚到时只剩文字重排，不会改变
 * 消息高度。纯文本行仍是纯文本节点，不引入语法解释，也不改变可读内容。
 */
export function markdownPlaceholderBlocks(content: string): readonly string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (!current.length) return;
    blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of content.split("\n")) {
    if (line.trim()) current.push(line);
    else flush();
  }
  flush();
  return blocks.length ? blocks : [""];
}

/** Keep the canonical parser/renderer out of the cold shell. Reuse the shared
 * request, unmount and explicit-retry lifecycle; text stays readable meanwhile. */
export const DeferredMarkdownPreview = deferredComponent<MarkdownPreviewProps>(
  () => import("./markdown.js").then(module => module.MarkdownPreview),
  { title: "正文排版", renderPending: (status, props, { failed }) => <div aria-busy={!failed}
    className={classNames("wand-markdown-preview", props.variant === "inline" && "wand-markdown-preview-inline", props.wrap && "wrap")}
    style={{ fontSize: props.fontSize == null ? undefined : `${props.fontSize}px`, overflowWrap: "anywhere" }}>
    {markdownPlaceholderBlocks(props.content).map((block, index) => <p key={index}>{props.renderText ? props.renderText(block) : block}</p>)}
    {failed ? status : null}
  </div> },
);
