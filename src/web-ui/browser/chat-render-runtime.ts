export type ChatRuntime = Pick<typeof import("./chat-render"), "renderChat" | "scheduleChatRender" | "clearActivityDetailState">;
let active: ChatRuntime | null = null;

/** Compatibility and production entrypoints share the same optional view owner. */
export function registerChatRuntime(runtime: ChatRuntime): void { active = runtime; }
export function chatRuntime(): ChatRuntime | null { return active; }
