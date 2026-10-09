import * as React from "react";
import { BrowserSpeechInput, readSpeechMode } from "../speech/repository";
import { WandIconButton } from "../ui";
import { ConversationMorphIcon } from "../conversations/controls";
import { bindIdleSpeechInput } from "../speech/hold-input";

/** Only records/transcribes. The caller's composer performs the revision-checked edit. */
export function ComposerSpeechButton({ ownerKey, revision, disabled, inputPlaceholder, onCommit, onStatus }: {
  ownerKey: string; revision: number; disabled?: boolean; inputPlaceholder?: string;
  onCommit(text: string, capturedRevision: number): void;
  onStatus(status: string): void;
}) {
  const [phase, setPhase] = React.useState<"idle" | "recording" | "processing">("idle");
  const button = React.useRef<HTMLButtonElement>(null);
  const idleInput = React.useRef<ReturnType<typeof bindIdleSpeechInput> | null>(null);
  const active = React.useRef<{ input: BrowserSpeechInput; key: string; revision: number } | null>(null);
  const gesture = React.useRef<{ y: number; cancelled: boolean; pointerId: number | null }>({ y: 0, cancelled: false, pointerId: null });
  const liveStatus = React.useRef("正在聆听…");
  const current = React.useRef({ ownerKey, revision, onStatus }); current.current = { ownerKey, revision, onStatus };
  const cancel = React.useCallback(() => { active.current?.input.cancel(); active.current = null; setPhase("idle"); current.current.onStatus(""); }, []);
  React.useEffect(() => {
    if (active.current && (active.current.key !== ownerKey || active.current.revision !== revision || disabled)) cancel();
  }, [ownerKey, revision, disabled, cancel]);
  React.useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    const hidden = () => { if (document.hidden) cancel(); };
    const move = (event: PointerEvent) => {
      if (!active.current || gesture.current.pointerId !== event.pointerId) return;
      gesture.current.cancelled = gesture.current.y - event.clientY > 60;
      current.current.onStatus(gesture.current.cancelled ? "松开取消" : liveStatus.current);
    };
    const release = (event: PointerEvent) => {
      if (gesture.current.pointerId !== event.pointerId) return;
      gesture.current.pointerId = null;
      if (event.type === "pointercancel" || gesture.current.cancelled) cancel(); else active.current?.input.finish();
    };
    document.addEventListener("keydown", escape); document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release);
    window.addEventListener("pagehide", cancel); window.addEventListener("wand-voice-settings-change", cancel);
    return () => { active.current?.input.cancel(); active.current = null;
      document.removeEventListener("keydown", escape); document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release);
      window.removeEventListener("pagehide", cancel); window.removeEventListener("wand-voice-settings-change", cancel); };
  }, [cancel]);
  function begin() {
    if (disabled) return;
    if (active.current) { cancel(); return; }
    const key = ownerKey, capturedRevision = revision, commit = onCommit;
    const input = new BrowserSpeechInput(readSpeechMode(), {
      onStatus: (status) => { liveStatus.current = status; if (active.current?.input === input) onStatus(gesture.current.cancelled ? "松开取消" : status); },
      onPartial: (text) => { liveStatus.current = text || "正在聆听…"; if (active.current?.input === input && !gesture.current.cancelled) onStatus(liveStatus.current); },
      onProcessing: () => {
        if (active.current?.input !== input) return;
        if (gesture.current.cancelled) { cancel(); return; }
        gesture.current.pointerId = null;
        setPhase("processing");
      },
      onFinal: (text) => {
        if (active.current?.input !== input) return;
        active.current = null; setPhase("idle");
        onStatus(text ? "" : "未识别到语音，请重新按住说话。");
        if (text && current.current.ownerKey === key && current.current.revision === capturedRevision) commit(text, capturedRevision);
      },
      onError: (message) => { if (active.current?.input === input) { active.current = null; setPhase("idle"); onStatus(message); } },
    });
    active.current = { input, key, revision: capturedRevision };
    setPhase("recording"); onStatus("正在准备麦克风…");
    void input.start();
  }
  function finish() { if (gesture.current.cancelled) cancel(); else active.current?.input.finish(); }
  const inputActions = React.useRef({ disabled, phase, begin, finish });
  inputActions.current = { disabled, phase, begin, finish };
  React.useLayoutEffect(() => {
    const input = button.current?.closest(".conversation-composer,[data-speech-composer]")?.querySelector<HTMLTextAreaElement>("textarea");
    if (!input) return;
    const binding = bindIdleSpeechInput(input, {
      enabled: () => !inputActions.current.disabled,
      begin: (event) => { gesture.current = { y: event.clientY, cancelled: false, pointerId: event.pointerId }; inputActions.current.begin(); },
      move: (event) => { if (inputActions.current.phase !== "recording") return;
        gesture.current.cancelled = gesture.current.y - event.clientY > 60;
        current.current.onStatus(gesture.current.cancelled ? "松开取消" : liveStatus.current); },
      finish: () => inputActions.current.finish(), cancel,
    });
    idleInput.current = binding;
    return () => { binding.dispose(); if (idleInput.current === binding) idleInput.current = null; };
  }, [ownerKey, cancel]);
  React.useLayoutEffect(() => { idleInput.current?.sync(inputPlaceholder); }, [revision, disabled, inputPlaceholder]);
  return <WandIconButton ref={button} aria-label={phase === "processing" ? "取消语音识别" : phase === "recording" ? "松开结束，上滑取消" : "按住语音输入"}
    aria-pressed={phase === "recording"} aria-busy={phase === "processing"} disabled={disabled} style={{ width: 44, height: 44, touchAction: "none" }}
    onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { y: event.clientY, cancelled: false, pointerId: event.pointerId }; begin(); }}
    onPointerMove={event => { if (phase !== "recording") return; gesture.current.cancelled = gesture.current.y - event.clientY > 60; onStatus(gesture.current.cancelled ? "松开取消" : liveStatus.current); }}
    onPointerUp={event => { event.preventDefault(); finish(); }} onPointerCancel={cancel}
    onClick={event => { if (event.detail !== 0) return; if (phase === "processing") cancel(); else if (phase === "recording") finish(); else begin(); }}>
    <ConversationMorphIcon from="mic" to="stop" active={phase !== "idle"}/>
  </WandIconButton>;
}
