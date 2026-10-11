import * as React from "react";
import { installChatSurfaceStyles } from "./styles";

type MessageSlot = "root" | "avatar" | "body" | "header" | "content" | "footer";
export type ChatMessageProps = Omit<React.HTMLAttributes<HTMLDivElement>, "content"> & {
  own?: boolean;
  surface?: "message" | "document" | "preview";
  content: React.ReactNode;
  avatar?: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  styles?: Partial<Record<MessageSlot, React.CSSProperties>>;
};

/** Wand owns message geometry; callers keep their content, actions and DOM nodes. */
export function ChatMessage({ own = false, surface = "message", content, avatar, header, footer,
  styles, className, style, ...props }: ChatMessageProps): React.ReactElement {
  React.useInsertionEffect(installChatSurfaceStyles, []);
  return <div {...props} className={["wand-chat-message", className].filter(Boolean).join(" ")}
    data-chat-renderer="canonical" data-chat-role={own ? "user" : "assistant"} data-chat-surface={surface}
    style={{ ...styles?.root, ...style }}>
    {avatar != null ? <div className="wand-chat-message-avatar" style={styles?.avatar}>{avatar}</div> : null}
    <div className="wand-chat-message-body" style={styles?.body}>
      {header != null ? <div className="wand-chat-message-header" style={styles?.header}>{header}</div> : null}
      <div className="wand-chat-message-content" style={styles?.content}>{content}</div>
      {footer != null ? <div className="wand-chat-message-footer" style={styles?.footer}>{footer}</div> : null}
    </div>
  </div>;
}
