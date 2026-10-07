import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

function sameDraft<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Snapshot refreshes may update clean forms; a save receipt only settles its submitted draft. */
export function useSettingsDraft<T>(saved: T): [T, Dispatch<SetStateAction<T>>, (submitted: T, accepted: T) => void] {
  const [draft, setDraft] = useState(saved);
  const previousSaved = useRef(saved);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    const previous = previousSaved.current;
    previousSaved.current = saved;
    setDraft((current) => sameDraft(current, previous) ? saved : current);
  }, [savedKey]);
  const acceptSaved = (submitted: T, accepted: T): void => {
    setDraft((current) => sameDraft(current, submitted) ? accepted : current);
  };
  return [draft, setDraft, acceptSaved];
}
