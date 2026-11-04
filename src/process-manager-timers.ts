/**
 * Timer group owned by one session record. clearAll() is the single teardown
 * point for exit, stop, cleanup and delete paths.
 */
export class SessionTimers {
  /** Quiet-window timer for the non-Claude PTY turn tracker. */
  ptyTurn: NodeJS.Timeout | null = null;
  /** Delayed initial input delivery. */
  initialInput: NodeJS.Timeout | null = null;

  clearPtyTurn(): void {
    if (this.ptyTurn) clearTimeout(this.ptyTurn);
    this.ptyTurn = null;
  }

  clearInitialInput(): void {
    if (this.initialInput) clearTimeout(this.initialInput);
    this.initialInput = null;
  }

  /** Cancels every timer in the group. Safe to call repeatedly. */
  clearAll(): void {
    this.clearPtyTurn();
    this.clearInitialInput();
  }
}
