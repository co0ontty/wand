/**
 * Session Lifecycle Manager
 * Inspired by Happy's session lifecycle management
 */

import type { SessionLifecycleState, SessionLifecycle } from "./types.js";

export interface SessionLifecycleEvents {
  onStateChange?: (sessionId: string, oldState: SessionLifecycleState, newState: SessionLifecycleState) => void;
  onIdle?: (sessionId: string) => void;
  onArchived?: (sessionId: string, reason: string) => void;
}

export class SessionLifecycleManager {
  private sessions: Map<string, SessionLifecycle> = new Map();
  private events: SessionLifecycleEvents;
  private idleTimeout: number;
  private archiveTimeout: number;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    events: SessionLifecycleEvents = {},
    options: { idleTimeout?: number; archiveTimeout?: number } = {}
  ) {
    this.events = events;
    this.idleTimeout = options.idleTimeout ?? 5 * 60 * 1000; // 5 minutes
    this.archiveTimeout = options.archiveTimeout ?? 30 * 60 * 1000; // 30 minutes
    
    // Start periodic check
    this.startPeriodicCheck();
  }

  /**
   * Register a new session
   */
  register(sessionId: string, initialState: SessionLifecycleState = "initializing"): void {
    const lifecycle: SessionLifecycle = {
      state: initialState,
      stateSince: Date.now(),
      lastActivityAt: Date.now(),
    };

    this.sessions.set(sessionId, lifecycle);
  }

  /**
   * Update session state
   */
  setState(sessionId: string, newState: SessionLifecycleState): void {
    const lifecycle = this.sessions.get(sessionId);
    if (!lifecycle) {
      return;
    }

    const oldState = lifecycle.state;
    if (oldState === newState) {
      return;
    }

    lifecycle.state = newState;
    lifecycle.stateSince = Date.now();
    lifecycle.lastActivityAt = Date.now();

    // Emit state change event
    this.events.onStateChange?.(sessionId, oldState, newState);
  }

  /**
   * Update last activity timestamp
   */
  touch(sessionId: string): void {
    const lifecycle = this.sessions.get(sessionId);
    if (lifecycle) {
      lifecycle.lastActivityAt = Date.now();
    }
  }

  /**
   * Mark session as thinking
   */
  startThinking(sessionId: string): void {
    this.setState(sessionId, "thinking");
  }

  /**
   * Mark session as done thinking
   */
  stopThinking(sessionId: string): void {
    const lifecycle = this.sessions.get(sessionId);
    if (lifecycle?.state === "thinking") {
      this.setState(sessionId, "idle");
    }
  }

  /**
   * Mark session as waiting for input
   */
  waitingInput(sessionId: string): void {
    this.setState(sessionId, "waiting-input");
  }

  /**
   * Archive a session
   */
  archive(sessionId: string, reason: string, by: "user" | "timeout" | "error" = "user"): void {
    const lifecycle = this.sessions.get(sessionId);
    if (!lifecycle) {
      return;
    }

    lifecycle.state = "archived";
    lifecycle.stateSince = Date.now();
    lifecycle.archivedBy = by;
    lifecycle.archiveReason = reason;

    // Emit archived event
    this.events.onArchived?.(sessionId, reason);
  }

  /**
   * Unregister a session
   */
  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Get session lifecycle
   */
  get(sessionId: string): SessionLifecycle | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   */
  getAll(): Map<string, SessionLifecycle> {
    return new Map(this.sessions);
  }

  /**
   * Get sessions by state
   */
  getByState(state: SessionLifecycleState): string[] {
    const result: string[] = [];
    for (const [sessionId, lifecycle] of this.sessions) {
      if (lifecycle.state === state) {
        result.push(sessionId);
      }
    }
    return result;
  }

  /**
   * Start periodic check for idle/archived sessions
   */
  private startPeriodicCheck(): void {
    if (this.checkInterval) {
      return;
    }

    this.checkInterval = setInterval(() => {
      this.checkSessions();
    }, 60 * 1000); // Check every minute
  }

  /**
   * Stop periodic check
   */
  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Check sessions for idle/archived status
   */
  private checkSessions(): void {
    const now = Date.now();

    for (const [sessionId, lifecycle] of this.sessions) {
      try {
        if (lifecycle.state === "archived") {
          continue;
        }

        const timeSinceLastActivity = now - lifecycle.lastActivityAt;

        // Check for archive timeout
        if (timeSinceLastActivity > this.archiveTimeout) {
          this.archive(sessionId, "Session timed out", "timeout");
          continue;
        }

        // Check for idle timeout
        if (timeSinceLastActivity > this.idleTimeout && lifecycle.state !== "idle") {
          this.setState(sessionId, "idle");
          this.events.onIdle?.(sessionId);
        }
      } catch (err) {
        console.error(`[Lifecycle] Error checking session ${sessionId}: ${String(err)}`);
      }
    }
  }

  /**
   * Cleanup all sessions
   */
  cleanup(): void {
    this.stopPeriodicCheck();
    this.sessions.clear();
  }
}
