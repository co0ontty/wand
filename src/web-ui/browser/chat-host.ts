/** Stable legacy host shared by synchronous selection and the optional renderer. */
export function ensureChatMessagesContainer(chatOutput: HTMLElement | null): HTMLElement | null {
  if (!chatOutput) return null;
  const current = chatOutput.querySelector<HTMLElement>(".chat-messages");
  if (current) return current;
  const root = document.createElement("div");
  root.className = "chat-messages";
  chatOutput.appendChild(root);
  return root;
}
