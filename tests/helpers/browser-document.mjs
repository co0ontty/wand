const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class BrowserCommandError extends Error {
  constructor(method, error) {
    super(`Browser command rejected: ${method}: ${error.message}`);
    this.method = method;
    this.code = error.code;
  }
}

export class BrowserDocumentChangedError extends Error {
  constructor(cause) {
    super("Browser document changed during evaluation", { cause });
  }
}

/** CDP lifecycle evidence, not error wording, identifies a stale evaluation. */
export function createDocumentEvaluator(send) {
  let revision = 0;
  let mainFrameId;
  let navigating = false;
  return {
    setMainFrame(id) { mainFrameId = id; },
    observe(event) {
      if (event.method === "Page.frameNavigated" && !event.params?.frame?.parentId) {
        mainFrameId = event.params?.frame?.id;
        revision++;
      } else if (event.method === "Runtime.executionContextsCleared"
          || (event.method === "Page.frameStartedLoading" && mainFrameId
            && event.params?.frameId === mainFrameId)) {
        // Reads can start after loading begins but before the old context dies.
        navigating = true;
        revision++;
      } else if ((event.method === "Page.frameStoppedLoading" && event.params?.frameId === mainFrameId)
          || (event.method === "Runtime.executionContextCreated"
            && event.params?.context?.auxData?.isDefault
            && event.params.context.auxData.frameId === mainFrameId)) {
        navigating = false;
      }
    },
    async evaluate(expression) {
      const startedRevision = revision;
      const startedDuringNavigation = navigating;
      let result;
      try {
        result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      } catch (error) {
        // -32000 is CDP's runtime/server error. Invalid parameters, unsupported
        // commands, transport deadlines and JS exceptions must not be retried.
        if (error instanceof BrowserCommandError && error.method === "Runtime.evaluate"
            && error.code === -32000 && (revision !== startedRevision || startedDuringNavigation)) {
          throw new BrowserDocumentChangedError(error);
        }
        throw error;
      }
      if (result.exceptionDetails) throw new Error("Browser evaluation failed");
      return result.result.value;
    },
  };
}

/** Retry only an invalidated document read, within the original bounded wait. */
export async function waitForBrowserCondition(evaluate, expression, label = "DOM ready", {
  attempts = 150, intervalMs = 40, sleep = pause,
} = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await evaluate(expression)) return;
    } catch (error) {
      if (!(error instanceof BrowserDocumentChangedError)) throw error;
    }
    await sleep(intervalMs);
  }
  throw new Error("Browser condition missing: " + label);
}
