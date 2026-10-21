import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { WandUiProvider } from "../react/theme";

const roots = new Map<HTMLElement, Root>();
const pending = new Set<HTMLElement>();

export function mountLoginControls(): void {
  for (const [target, root] of roots) if (!target.isConnected) { root.unmount(); roots.delete(target); }
  const target = document.querySelector<HTMLElement>("[data-login-controls]");
  if (!target || roots.has(target) || pending.has(target)) return;
  pending.add(target);
  // The re-login form pulls AntD's Form/Input stack; the anonymous login page
  // and the normal console never need it, so fetch it only when the server
  // injects this container after a session lost authentication. The login
  // artwork lives in the same situation: the anonymous page has its own entry.
  void Promise.all([
    import("../react/login/host.js"),
    import("./login-visual.js"),
    import("../brand-identity.js"),
  ]).then(([{ LoginForm }, { renderLoginVisual }, { renderWandBrandMarkup }]) => {
    pending.delete(target);
    if (!target.isConnected || roots.has(target)) return;
    const root = createRoot(target); roots.set(target, root);
    const visual = <div dangerouslySetInnerHTML={{ __html: renderLoginVisual(renderWandBrandMarkup("brand-logo")) }}/>;
    const httpHref = "http://" + location.host + location.pathname;
    flushSync(() => root.render(<WandUiProvider><LoginForm checking={target.dataset.checking === "true"} switchServer={target.dataset.switchServer === "true"} visual={visual} httpHref={httpHref}/></WandUiProvider>));
  }).catch(() => {
    pending.delete(target);
    target.textContent = "登录界面加载失败，请重新加载页面。";
  });
}
