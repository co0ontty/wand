export interface DialogOpenChangeDetails {
  readonly reason?: string;
  cancel(): void;
}

export const DIALOG_OUTSIDE_PRESS_GRACE_MS = 500;

/**
 * Ignore the trailing press from the interaction that just opened a dialog.
 * For example, the second press of a double-click lands on the newly mounted
 * backdrop and otherwise closes the dialog immediately.
 */
export function handleDialogOpenChange(
  nextOpen: boolean,
  details: DialogOpenChangeDetails,
  dismissable: boolean,
  openedAt: number,
  now: number,
  onOpenChange: (open: boolean) => void,
): void {
  if (!nextOpen && details.reason === "outside-press") {
    if (!dismissable || now - openedAt < DIALOG_OUTSIDE_PRESS_GRACE_MS) {
      details.cancel();
      return;
    }
  }
  if (!nextOpen && !dismissable && details.reason === "escape-key") {
    details.cancel();
    return;
  }
  onOpenChange(nextOpen);
}
