import { useEffect, useRef } from "react";

interface ImeKeyboardEvent {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export interface ImeGuard {
  onCompositionStart(): void;
  onCompositionEnd(): void;
  isComposing(): boolean;
  shouldIgnore(event: ImeKeyboardEvent): boolean;
  reset(): void;
}

/** Keep candidate-confirming keys inside the input, including WebKit's trailing keydown. */
export function createImeGuard(): ImeGuard {
  let composing = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    onCompositionStart(): void {
      cancelTimer();
      generation += 1;
      composing = true;
    },
    onCompositionEnd(): void {
      cancelTimer();
      // Safari may emit compositionend before an Enter/Escape with isComposing=false.
      // Retain the guard for this event turn, without delaying subsequent deliberate keys.
      composing = true;
      const endedGeneration = generation;
      timer = setTimeout(() => {
        if (generation !== endedGeneration) return;
        composing = false;
        timer = undefined;
      }, 0);
    },
    isComposing(): boolean { return composing; },
    shouldIgnore(event): boolean {
      return composing || event.isComposing === true || event.keyCode === 229
        || event.nativeEvent?.isComposing === true || event.nativeEvent?.keyCode === 229;
    },
    reset(): void {
      cancelTimer();
      generation += 1;
      composing = false;
    },
  };
}

/** One guard per mounted input; draft projections never reset an active composition. */
export function useImeGuard(): ImeGuard {
  const guard = useRef<ImeGuard | null>(null);
  if (!guard.current) guard.current = createImeGuard();
  useEffect(() => () => guard.current?.reset(), []);
  return guard.current;
}
