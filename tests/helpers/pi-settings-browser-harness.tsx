import * as React from "react";
import { createRoot } from "react-dom/client";
import { PiSettingsHost } from "../../src/web-ui/react/pi-settings/host.js";
import { piSettingsController } from "../../src/web-ui/react/pi-settings/controller.js";
import { installReactUiStyles } from "../../src/web-ui/react/styles.js";
import { composer, state } from "../../src/web-ui/browser/state.js";
import { syncPiSettingsComposer, handlePiSettingsSubmit, handlePiSettingsKeydown } from "../../src/web-ui/browser/pi-settings-adapter.js";

installReactUiStyles();
state.sessions = [{ id: "a", sessionKind: "structured", provider: "pi" }, { id: "b", sessionKind: "structured", provider: "pi" },
  { id: "pty", sessionKind: "pty", provider: "pi" }, { id: "codex", sessionKind: "structured", provider: "codex" }] as typeof state.sessions;
state.selectedId = "a";

function Harness(): React.ReactElement {
  const input = React.useRef<HTMLTextAreaElement>(null);
  const [current, setCurrent] = React.useState("a");
  React.useEffect(() => { syncPiSettingsComposer(); }, [current]);
  function change(id: string): void {
    if (input.current) composer.edit(state.selectedId, { text: input.current.value });
    state.selectedId = id; setCurrent(id);
    if (input.current) input.current.value = composer.read(id).text;
    syncPiSettingsComposer();
  }
  return (
    <>
      <div id="switcher">
        {["a", "b", "pty", "codex"].map((id) => <button id={`switch-${id}`} key={id} onClick={() => change(id)}>{id}</button>)}
      </div>
      <div className="input-panel">
        <div className="input-composer-row" data-pi-composer="">
          <span data-pi-settings-host=""/>
          <div className="input-composer">
            <div className="composer-actions-left">
              <span className="composer-pi-settings-toggle-host" data-pi-settings-toggle-host=""/>
            </div>
            <textarea id="input-box" ref={input}
              onInput={(event) => { composer.edit(state.selectedId, { text: event.currentTarget.value }); syncPiSettingsComposer(); }}
              onCompositionStart={() => { state.composerComposing = true; syncPiSettingsComposer(); }}
              onCompositionEnd={() => { state.composerComposing = false; syncPiSettingsComposer(); }}
              onKeyDown={(event) => { handlePiSettingsKeydown(event.nativeEvent); }}/>
            <button id="submit" onClick={() => {
              const session = state.sessions.find((item) => item.id === state.selectedId);
              const handled = handlePiSettingsSubmit(input.current?.value ?? "", session);
              (window as unknown as { lastSubmitHandled: boolean }).lastSubmitHandled = handled;
            }}>发送</button>
          </div>
        </div>
      </div>
      <PiSettingsHost/>
    </>
  );
}

(window as unknown as { piHarness: unknown }).piHarness = { state, composer, piSettingsController, syncPiSettingsComposer };
createRoot(document.getElementById("root")!).render(<Harness/>);
