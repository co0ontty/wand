export type PtyInputMode = "shortcuts" | "keyboard";
/** open: the key dock is expanded; collapsed by default because PTY keys are rarely needed. */
export interface PtyInputState { readonly mode: PtyInputMode; readonly ctrl: boolean; readonly shift: boolean; readonly open: boolean; }
export interface PtyModifiers { ctrl: boolean; shift: boolean; alt?: boolean; }
const initial: PtyInputState = Object.freeze({ mode: "shortcuts", ctrl: false, shift: false, open: false });
const sessions = new Map<string, PtyInputState>();
const listeners = new Set<() => void>();

/** Device-local presentation intent, scoped to a session; never an execution receipt. */
export const ptyInputState = {
  read(owner: string | null | undefined): PtyInputState { return owner ? sessions.get(owner) ?? initial : initial; },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  update(owner: string, patch: Partial<PtyInputState>): void {
    if (!owner) return;
    const previous = this.read(owner), next = { ...previous, ...patch };
    if (next.mode === previous.mode && next.ctrl === previous.ctrl && next.shift === previous.shift && next.open === previous.open) return;
    sessions.delete(owner); sessions.set(owner, Object.freeze(next));
    // Keep transient UI state bounded; reload also returns to unmodified keys.
    if (sessions.size > 128) sessions.delete(sessions.keys().next().value!);
    for (const listener of listeners) listener();
  },
  toggle(owner: string, modifier: "ctrl" | "shift"): void { this.update(owner, { [modifier]: !this.read(owner)[modifier] }); },
};

export function mergePtyModifiers(owner: string | null | undefined, physical: PtyModifiers): PtyModifiers {
  const held = ptyInputState.read(owner);
  return { ctrl: physical.ctrl || held.ctrl, shift: physical.shift || held.shift, alt: physical.alt };
}

/** Xterm/ECMA-48 modified cursor keys. null means use the existing unmodified encoder. */
export function modifiedPtySequence(key: string, modifiers: PtyModifiers): string | null {
  const { ctrl, shift, alt } = modifiers;
  if (!ctrl && !shift && !alt) return null;
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const cursors: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
  const cursor = cursors[key];
  if (cursor) return `\x1b[1;${modifier}${cursor}`;
  const tildes: Record<string, number> = { insert: 2, delete: 3, pageup: 5, pagedown: 6 };
  const tilde = tildes[key];
  if (tilde) return `\x1b[${tilde};${modifier}~`;
  if (key === "tab" && shift) return "\x1b[Z";
  if (key.length !== 1) return null;
  const text = shift ? key.toUpperCase() : key;
  if (ctrl) {
    const lower = text.toLowerCase();
    if (lower >= "a" && lower <= "z") return String.fromCharCode(lower.charCodeAt(0) - 96);
    const symbols: Record<string, number> = { " ": 0, "@": 0, "[": 27, "\\": 28, "]": 29, "^": 30, "_": 31 };
    return symbols[text] === undefined ? null : String.fromCharCode(symbols[text]);
  }
  if (alt) return "\x1b" + text;
  return text;
}

/** Browser/IME text events can lack keydown. Transform only a single typed ASCII key, never paste or composition. */
export function modifiedTypedPtyText(text: string, event: { inputType?: string; data?: string | null } | undefined, modifiers: PtyModifiers): string | null {
  if (event?.inputType !== "insertText" || event.data !== text || text.length !== 1 || text.charCodeAt(0) > 127) return null;
  return modifiedPtySequence(text, modifiers);
}
