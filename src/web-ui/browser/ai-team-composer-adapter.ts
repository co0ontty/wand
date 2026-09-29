import { configureTeamChatComposerRuntime } from "../react/ai-teams/composer-bridge";
import { composer } from "./state";

let uninstall: (() => void) | null = null;

export function installAiTeamComposerAdapter(): void {
  if (uninstall) return;
  uninstall = configureTeamChatComposerRuntime({
    read: (sessionId) => composer.read(sessionId),
    edit: (sessionId, change) => composer.edit(sessionId, change),
    submit: (sessionId, text, deliver) => composer.submit(sessionId, text, deliver),
    subscribe: (listener) => composer.subscribe(listener),
  });
}
