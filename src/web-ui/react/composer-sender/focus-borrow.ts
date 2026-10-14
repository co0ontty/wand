/** Temporary tools borrow the editor's focus without ending the editing session. */
export function borrowComposerFocus(surface: HTMLElement | null | undefined, owner: string): () => void {
  const publish = (active: boolean): void => { surface?.dispatchEvent(new CustomEvent("wand-composer-focus-borrow", { bubbles: true, detail: { owner, active } })); };
  publish(true);
  return () => publish(false);
}
