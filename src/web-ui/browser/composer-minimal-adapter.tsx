import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { MinimalComposerEntry, useMinimalComposer } from "../react/composer-sender/minimal.js";
import { WandUiProvider } from "../react/theme.js";
import { PtyInputModeToggle, PtyDockToggle, type PtyInputMode } from "../react/composer-rail/input-mode-toggle.js";
import { closePlusPopover } from "./session-engine.js";
import { ptyInputState } from "../pty-input-state.js";
import { PtyModifierButtons } from "../react/composer-rail/modifiers.js";
import { composer, state } from "./state.js";
import type { ResizeInput } from "../react/composer-sender/host.js";

const mounts = new Map<HTMLElement, { root: Root; chrome: HTMLElement }>();
function MinimalComposer({ host, input, resize }: { host: HTMLElement; input: HTMLTextAreaElement; resize: ResizeInput }) {
  const [, refresh] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => composer.subscribe(refresh), []);
  React.useEffect(() => ptyInputState.subscribe(refresh), []);
  React.useLayoutEffect(() => {
    const runtime = host.querySelector<HTMLElement>(".composer-inline-config");
    if (!runtime) return;
    const measure = (): void => {
      const rect = runtime.getBoundingClientRect();
      host.style.setProperty("--composer-runtime-width", `${Math.ceil(rect.width)}px`);
      host.style.setProperty("--composer-runtime-height", `${Math.ceil(rect.height)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(runtime);
    return () => observer.disconnect();
  }, [host]);
  React.useEffect(() => {
    const observer = new MutationObserver(refresh);
    const action = host.querySelector("#send-input-button");
    if (action) observer.observe(action, { attributes: true, attributeFilter: ["data-phase"] });
    observer.observe(input, { attributes: true, attributeFilter: ["disabled", "readonly", "placeholder"] });
    const keys = host.querySelector(".terminal-shortcuts");
    if (keys) observer.observe(keys, { attributes: true, attributeFilter: ["hidden"] });
    let frame = 0;
    const finishedComposition = (): void => { frame = requestAnimationFrame(refresh); };
    input.addEventListener("compositionstart", refresh);
    input.addEventListener("compositionend", finishedComposition);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); input.removeEventListener("compositionstart", refresh); input.removeEventListener("compositionend", finishedComposition); };
  }, [host, input]);
  const owner = state.selectedId ?? "";
  const draft = composer.read(owner);
  const phase = host.querySelector<HTMLElement>("#send-input-button")?.dataset.phase ?? "idle";
  // Native input embeds own their keyboard and shortcut UI; the Web switch is
  // available only when the existing Web shortcut host is actually enabled.
  const shortcuts = host.querySelector<HTMLElement>(".terminal-shortcuts");
  const terminal = !!shortcuts && !shortcuts.hidden;
  const choice = ptyInputState.read(owner);
  const toggle = React.useRef<HTMLButtonElement>(null);
  const selection = React.useRef<{ owner: string; start: number; end: number; direction: typeof input.selectionDirection; scroll: number } | null>(null);
  const failed = phase === "failed" || phase === "unknown" || !!draft.recovery;
  const mode: PtyInputMode = failed ? "keyboard" : choice.mode;
  const locked = input.readOnly || !!draft.recovery || state.composerComposing;
  const rememberSelection = (): void => {
    selection.current = { owner, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, scroll: input.scrollTop };
  };
  React.useEffect(() => { if (terminal && failed) ptyInputState.update(owner, { mode: "keyboard" }); }, [owner, terminal, failed]);
  const minimal = useMinimalComposer({ owner, input: () => input, surface: () => host,
    phase, pending: !!draft.text || !!draft.attachments.length, locked,
    forceExpanded: terminal && mode === "keyboard",
    onDismiss: reason => {
      if (!terminal) return;
      rememberSelection(); ptyInputState.update(owner, { mode: "shortcuts" });
      if (reason === "escape" || reason === "back") requestAnimationFrame(() => (toggle.current?.offsetParent ? toggle.current : host.querySelector<HTMLElement>(".pty-dock-toggle"))?.focus({ preventScroll: true }));
    },
    popupOwners: ["composer-plus-popover", "composer-main", `wand-pi-settings-${owner}`, `wand-pi-codemode-${owner}`, `pty-extra-keys-${owner}`] });
  // Keys are rarely needed: rest as one slim entry until asked. Held modifiers or a
  // failed/unknown submit must stay visible, so those states never rest collapsed.
  const collapsed = terminal && !choice.open && mode === "shortcuts" && !choice.ctrl && !choice.shift;
  React.useLayoutEffect(() => {
    host.dataset.composerExpanded = String(minimal.expanded);
    if (terminal) host.dataset.ptyInputMode = mode; else delete host.dataset.ptyInputMode;
    if (collapsed) host.dataset.ptyCollapsed = "true"; else delete host.dataset.ptyCollapsed;
    const editing = terminal ? mode === "keyboard" : minimal.expanded;
    input.tabIndex = editing ? 0 : -1;
    const wrap = host.querySelector<HTMLElement>(".composer-input-wrap");
    if (wrap) wrap.inert = !editing;
    if (shortcuts) { shortcuts.inert = terminal && (editing || collapsed); shortcuts.setAttribute("aria-hidden", String(!terminal || editing || collapsed)); }
    const extra = host.querySelector<HTMLElement>("[data-pty-extra-keys-host]");
    if (extra) extra.inert = !terminal || editing || collapsed;
    const rail = host.querySelector<HTMLElement>("[data-composer-rail-host]");
    if (rail) rail.inert = terminal && !editing;
    const controls = host.querySelector<HTMLElement>(".composer-editor-controls");
    if (controls) controls.inert = !editing;
    resize(input);
  }, [host, input, shortcuts, resize, minimal.expanded, terminal, mode, collapsed]);
  const changeMode = (): void => {
    // A composition is an edit, not a mode change. Never blur an active IME.
    if (locked || phase === "sending" || failed || state.composerComposing) return;
    closePlusPopover();
    if (mode === "keyboard") {
      rememberSelection(); input.blur();
      flushSync(() => ptyInputState.update(owner, { mode: "shortcuts" }));
      toggle.current?.focus({ preventScroll: true });
    } else {
      flushSync(() => ptyInputState.update(owner, { mode: "keyboard" }));
      minimal.open();
      const saved = selection.current;
      if (saved?.owner === owner) { input.setSelectionRange(saved.start, saved.end, saved.direction); input.scrollTop = saved.scroll; }
    }
  };
  const toggleDock = (): void => {
    if (state.composerComposing) return;
    closePlusPopover();
    if (collapsed) { ptyInputState.update(owner, { open: true }); return; }
    if (mode === "keyboard") { rememberSelection(); input.blur(); }
    ptyInputState.update(owner, { open: false, mode: "shortcuts", ctrl: false, shift: false });
  };
  return <>{createPortal(<>
    {terminal ? <><PtyDockToggle collapsed={collapsed} hasDraft={!!draft.text || !!draft.attachments.length} disabled={failed && !collapsed} onToggle={toggleDock}/>
      <PtyInputModeToggle ref={toggle} mode={mode} hasDraft={!!draft.text || !!draft.attachments.length} disabled={locked || phase === "sending" || failed} onToggle={changeMode}/>
      <PtyModifierButtons ctrl={choice.ctrl} shift={choice.shift} disabled={state.composerComposing}
        onToggle={key => { if (!state.composerComposing) ptyInputState.toggle(owner, key); }}/></> : null}
  </>, host.querySelector(".composer-main-row")!)}
    {createPortal(<MinimalComposerEntry text={draft.text} attachments={draft.attachments.length}
      placeholder={input.placeholder} disabled={input.disabled} onOpen={minimal.open}/>, host.querySelector(".composer-actions-left")!)}
  </>;
}

export function mountMinimalComposer(resize: ResizeInput): void {
  for (const [host, mount] of mounts) if (!host.isConnected) { mount.root.unmount(); mounts.delete(host); }
  const host = document.querySelector<HTMLElement>(".input-composer");
  const input = host?.querySelector<HTMLTextAreaElement>("#input-box");
  if (!host || !input) return;
  const previous = mounts.get(host);
  if (previous) {
    previous.root.render(<WandUiProvider><MinimalComposer host={host} input={input} resize={resize}/></WandUiProvider>);
    return;
  }
  const chrome = document.createElement("span"); host.appendChild(chrome);
  const root = createRoot(chrome); mounts.set(host, { root, chrome });
  flushSync(() => root.render(<WandUiProvider><MinimalComposer host={host} input={input} resize={resize}/></WandUiProvider>));
}
