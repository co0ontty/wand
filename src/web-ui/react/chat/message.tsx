import * as React from "react";
import { Bubble } from "@ant-design/x";

export type ChatMessageProps = Omit<React.ComponentProps<typeof Bubble>, "placement" | "variant" | "shape"> & {
  own?: boolean;
  surface?: "message" | "document" | "preview";
};

/** One message surface for sessions, conversations, run history and bounded previews. */
export function ChatMessage({ own = false, surface = "message", styles, ...props }: ChatMessageProps): React.ReactElement {
  return <Bubble {...props} data-chat-renderer="canonical" data-chat-role={own ? "user" : "assistant"}
    placement={own ? "end" : "start"} shape="corner"
    variant={surface === "document" ? "outlined" : own || surface === "preview" ? "filled" : "borderless"}
    styles={{ ...styles,
      body: { minWidth: 0, width: own ? undefined : "100%", maxWidth: own ? "calc(100% - 44px)" : "100%",
        marginInlineStart: own ? "auto" : undefined, ...styles?.body },
      content: { overflowWrap: "anywhere", ...(own || surface !== "message" ? {} : { padding: 0 }), ...styles?.content },
    }}/>
}
