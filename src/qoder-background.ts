interface Completion {
  taskId: string;
  toolCallId: string;
  outputFile: string;
  code: number | null;
  signal: string | null;
  cancelled?: boolean;
}
interface BackgroundShell {
  id: string;
  task?: Pick<Completion, "taskId" | "toolCallId" | "outputFile">;
  exit?: Pick<Completion, "code" | "signal">;
  delivered?: boolean;
  waiters: Array<(result: Completion) => void>;
}

/** Join official hook metadata to our own exit receipt, never output keywords or PID disappearance. */
export class QoderBackgroundTasks {
  private readonly shells = new Map<number, BackgroundShell>();
  private cancelled = false;
  private readonly registrations = new Map<number, { task: Pick<Completion, "taskId" | "toolCallId" | "outputFile">;
    promise: Promise<Completion>; resolve: (result: Completion) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> }>();

  accept(event: Record<string, unknown>, sessionId: string): boolean {
    const pid = event.pid;
    if (this.cancelled || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
    if (event.kind === "start" && typeof event.id === "string") {
      if (this.shells.size >= 2048) {
        for (const [key, value] of this.shells) {
          if (value.delivered || (value.exit && !value.task)) this.shells.delete(key);
          if (this.shells.size < 1024) break;
        }
      }
      if (this.shells.size >= 2048) return false;
      const previous = this.shells.get(pid);
      if (previous?.waiters.length) return false;
      this.shells.set(pid, { id: event.id, waiters: [] });
      const registration = this.registrations.get(pid);
      if (registration) {
        clearTimeout(registration.timer);
        this.registrations.delete(pid);
        void this.waitForTask({ kind: "task", sessionId, pid, ...registration.task }, sessionId).then(registration.resolve, registration.reject);
      }
      return true;
    }
    const shell = this.shells.get(pid);
    if (!shell) return false;
    if (event.kind === "exit" && event.id === shell.id
      && (event.code === null || typeof event.code === "number" && Number.isInteger(event.code))
      && (event.signal === null || typeof event.signal === "string")) {
      shell.exit = { code: event.code as number | null, signal: event.signal as string | null };
      if (shell.task) {
        for (const resolve of shell.waiters.splice(0)) resolve({ ...shell.task, ...shell.exit });
        shell.delivered = true;
      }
      return true;
    }
    if (event.kind === "task" && event.sessionId === sessionId && typeof event.taskId === "string"
      && typeof event.toolCallId === "string" && typeof event.outputFile === "string") {
      if (shell.task && shell.task.taskId !== event.taskId) return false;
      shell.task = { taskId: event.taskId, toolCallId: event.toolCallId, outputFile: event.outputFile };
      return true;
    }
    return false;
  }

  async waitForTask(event: Record<string, unknown>, sessionId: string): Promise<Completion> {
    if (this.cancelled || event.sessionId !== sessionId || typeof event.pid !== "number" || !Number.isSafeInteger(event.pid) || event.pid <= 0
      || typeof event.taskId !== "string" || typeof event.toolCallId !== "string" || typeof event.outputFile !== "string") {
      throw new Error("后台任务不属于当前执行，不能确认完成。");
    }
    const pid = event.pid;
    if (!this.shells.has(pid)) {
      // Qoder may publish backgrounded immediately after spawn, before the wrapper
      // has initialized. Wait for its authenticated owner-socket registration.
      const existing = this.registrations.get(pid);
      if (existing) {
        if (existing.task.taskId !== event.taskId) throw new Error("后台任务身份冲突。");
        return await existing.promise;
      }
      if (this.registrations.size >= 128) throw new Error("后台任务登记等待已满。");
      let resolve!: (result: Completion) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<Completion>((yes, no) => { resolve = yes; reject = no; });
      const timer = setTimeout(() => {
        this.registrations.delete(pid);
        reject(new Error("后台命令未及时登记，结果未知，禁止自动重跑。"));
      }, 30_000);
      timer.unref?.();
      this.registrations.set(pid, { task: { taskId: event.taskId, toolCallId: event.toolCallId, outputFile: event.outputFile }, promise, resolve, reject, timer });
      return await promise;
    }
    if (!this.accept(event, sessionId)) throw new Error("后台任务未能与本会话命令退出回执绑定，不能确认完成。");
    const shell = this.shells.get(pid)!;
    if (shell.exit) { shell.delivered = true; return { ...shell.task!, ...shell.exit }; }
    return await new Promise<Completion>(resolve => shell.waiters.push(resolve));
  }

  get pending(): number {
    return this.registrations.size + [...this.shells.values()].filter(shell => shell.task && !shell.delivered).length;
  }

  cancel(): void {
    this.cancelled = true;
    for (const registration of this.registrations.values()) {
      clearTimeout(registration.timer);
      registration.resolve({ ...registration.task, code: null, signal: null, cancelled: true });
    }
    this.registrations.clear();
    for (const shell of this.shells.values()) {
      if (shell.task) for (const resolve of shell.waiters.splice(0)) resolve({ ...shell.task, code: null, signal: null, cancelled: true });
    }
  }
}
