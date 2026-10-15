/**
 * Tracks active Core engine turns to prevent service restart during execution.
 */

export class CoreTurnTracker {
  // Each execution owns its token: a late cancelled turn cannot untrack its
  // replacement in the same session.
  private static activeTurns = new Map<symbol, string>();
  private static systemCallDrains = 0;

  /** Admission for one-shot SDK calls which do not enter the ordinary session input queue. */
  static beginSystemCallDrain(): () => void {
    this.systemCallDrains++;
    let released = false;
    return () => { if (!released) { released = true; this.systemCallDrains--; } };
  }

  static assertSystemCallAdmission(): void {
    if (this.systemCallDrains > 0) throw Object.assign(new Error("服务正在排空 Core，暂不接受新的 SDK 系统调用。"), { code: "SYSTEM_AI_DRAINING" });
  }

  static startTurn(sessionId: string, systemCall = false): symbol {
    if (systemCall) this.assertSystemCallAdmission();
    const token = Symbol(sessionId);
    this.activeTurns.set(token, sessionId);
    return token;
  }

  static endTurn(token: symbol): void {
    this.activeTurns.delete(token);
  }

  static hasActiveTurns(): boolean {
    return this.activeTurns.size > 0;
  }

  static getActiveTurnCount(): number {
    return this.activeTurns.size;
  }

  static getActiveTurnIds(): string[] {
    return [...new Set(this.activeTurns.values())];
  }

  static async waitForAllTurnsComplete(timeoutMs = 0): Promise<void> {
    const startTime = Date.now();
    
    while (this.hasActiveTurns()) {
      if (timeoutMs > 0 && Date.now() - startTime >= timeoutMs) {
        throw new Error(
          `Timeout waiting for Core turns to complete. ` +
          `${this.activeTurns.size} turns still active: ${this.getActiveTurnIds().join(", ")}`
        );
      }
      
      // Wait 1 second before checking again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
