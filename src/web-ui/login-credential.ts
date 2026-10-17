/** Recognize the issued credential wire format, not a user-selected login mode. */
export function isWebLoginTicket(value: string): boolean {
  return /^wlt_[a-zA-Z0-9_-]{43}$/.test(value);
}

/** Clear both the native field and Ant/React's internal input state, without retaining the credential. */
export function clearLoginCredential(input: HTMLInputElement): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, "");
  else input.value = "";
  // Calling input.value directly updates React's tracker before the input event,
  // leaving rc-input's internal value unchanged; a later render can resurrect it.
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
