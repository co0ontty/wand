import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { LoginForm } from "../react/login/host.js";
import { WandUiProvider } from "../react/theme";
import { renderLoginVisual } from "./login-visual.js";
import { renderWandBrandMarkup } from "../brand-identity.js";
const roots = new Map<HTMLElement, Root>();

export function mountLoginControls(): void {
  for (const [target, root] of roots) if (!target.isConnected) { root.unmount(); roots.delete(target); }
  const target = document.querySelector<HTMLElement>("[data-login-controls]");
  if (!target || roots.has(target)) return;
  const root = createRoot(target); roots.set(target, root);
  const visual = <div dangerouslySetInnerHTML={{ __html: renderLoginVisual(renderWandBrandMarkup("brand-logo")) }}/>;
  const httpHref = "http://" + location.host + location.pathname;
  flushSync(() => root.render(<WandUiProvider><LoginForm checking={target.dataset.checking === "true"} switchServer={target.dataset.switchServer === "true"} visual={visual} httpHref={httpHref}/></WandUiProvider>));
}
