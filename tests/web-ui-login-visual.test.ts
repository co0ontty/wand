import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm } from "../src/web-ui/react/login/host.tsx";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { renderLoginVisual } from "../src/web-ui/browser/login-visual.js";
import { renderLoginPageMarkup } from "../src/web-ui/browser/login-template.js";
import { renderWandBrandMarkup } from "../src/web-ui/brand-identity.js";
import { PROVIDER_IDS, renderProviderLogoMarkup } from "../src/web-ui/provider-identity.js";

const renderSource = readFileSync(
  new URL("../src/web-ui/browser/render.ts", import.meta.url), "utf8",
);
const styles = readFileSync(
  new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8",
);

// Execute the real, synchronous login template without importing the browser's
// WebSocket/terminal entry graph. Keep both anonymous and restoring branches.
function renderLogin(loginChecked: boolean, native = false): string {
  const start = renderSource.indexOf("export function renderLogin()");
  const end = renderSource.indexOf("export function renderAppShell(");
  assert.ok(start >= 0 && end > start);
  const seed = runInNewContext(
    renderSource.slice(start, end).replace("export function renderLogin", "function renderLogin") +
      "\nrenderLogin();",
    { state: { loginChecked }, hasNativeSwitchServer: () => native, renderLoginVisual, renderWandBrandMarkup },
  ) as string;
  const visual = React.createElement("div", { dangerouslySetInnerHTML: { __html: renderLoginVisual(renderWandBrandMarkup("brand-logo")) } });
  return seed.replace(/(<div data-login-controls[^>]*>)(<\/div>)/, "$1" + renderToStaticMarkup(React.createElement(LoginForm, { checking: !loginChecked, switchServer: native, visual })) + "$2");
}

test("login illustration reuses all seven local provider marks, without text or remote media", () => {
  const html = renderLogin(true);
  const scene = html.match(/<svg class="login-visual-scene"[\s\S]*?<\/svg>\s*<\/div>/)?.[0];
  assert.ok(scene);
  assert.match(scene, /aria-hidden="true" focusable="false"/);
  assert.equal(scene.replace(/<[^>]*>/g, "").trim(), "");
  assert.deepEqual(
    [...scene.matchAll(/data-provider-logo="([^"]+)"/g)].map((match) => match[1]),
    [...PROVIDER_IDS],
  );
  for (const provider of PROVIDER_IDS) {
    assert.ok(scene.includes(
      renderProviderLogoMarkup(provider).replace("<svg ", '<svg width="26" height="26" '),
    ));
  }
  assert.equal((scene.match(/width="44" height="44" class="brand-logo"/g) ?? []).length, 2);
  // The SVG namespace identifies markup; it is not a network resource.
  assert.doesNotMatch(scene.replaceAll('xmlns="http://www.w3.org/2000/svg"', ""),
    /<(?:script|foreignObject|image|video|iframe|text)\b|https?:\/\//i);
});

test("restoring and anonymous logins share one illustration and preserve the form/native controls", () => {
  for (const checked of [false, true]) {
    for (const native of [false, true]) {
      const html = renderLogin(checked, native);
      assert.equal((html.match(/class="login-visual"/g) ?? []).length, 1);
      assert.equal((html.match(/id="login-visual-paused"/g) ?? []).length, 1);
      assert.ok(html.indexOf('class="login-visual"') < html.indexOf('login-right'));
      assert.equal(html.includes('id="login-form"'), checked);
      assert.equal(html.includes('id="login-switch-server-button"'), checked && native);
      if (checked) {
        assert.match(html, /type="password"[^>]*id="password"|id="password"[^>]*type="password"/);
        assert.match(html, /id="login-button"[^>]*type="button"/);
        assert.match(html, /id="login-error"[^>]+role="alert"/);
      } else {
        assert.ok(html.includes("正在恢复会话"));
      }
    }
  }
});

test("login redesign keeps library credentials and drops the single-server address block", () => {
  const html = renderToStaticMarkup(React.createElement(LoginForm, { checking: false, switchServer: true }));
  assert.match(html, /<main class="login-page"/);
  assert.match(html, /id="login-title"/);
  assert.match(html, /你的 AI 工作台/);
  // 单机部署没有第二个服务可指，地址块只占地方：整块移除。
  assert.doesNotMatch(html, /当前服务|login-server|serverLabel/);
  assert.doesNotMatch(html, /终端 · AI 会话 · 工作区/);
  assert.doesNotMatch(html, /ant-card/);
  assert.match(html, /autoComplete="current-password"/);
  assert.equal((html.match(/id="password"/g) ?? []).length, 1);
  assert.match(html, /输入访问密码/);
  assert.doesNotMatch(html, /一次性票据|本机 CLI|登录方式|ant-segmented|data-login-kind/);
  assert.match(html, /aria-describedby="password-hint login-error"/);
  assert.match(html, /class="login-feedback" aria-live="polite"/);
  // 凭据说明只留一条，合并在密码框下方。
  assert.equal((html.match(/凭据只发送到本机 Wand 服务，不会保存在此页面。/g) ?? []).length, 1);
  assert.doesNotMatch(html, /login-privacy/);
  assert.ok(html.indexOf('id="login-cert-hint"') > html.indexOf('id="login-button"'), "certificate guidance cannot push the submit action down");
  assert.match(styles, /\.login-feedback \{ min-height: 44px;/);
  assert.match(styles, /#login-switch-server-button \{ height: 44px;/);
  const restoring = renderToStaticMarkup(React.createElement(LoginForm, { checking: true, switchServer: false }));
  assert.match(restoring, /aria-busy="true"/);
  assert.doesNotMatch(restoring, /id="password"/);
});

test("the vanilla login page matches the React form: no server address, one credential note", () => {
  const html = renderLoginPageMarkup("<svg class=\"brand-logo\"></svg>", "<div class=\"login-visual\"></div>");
  assert.match(html, /class="login-brand"/);
  assert.match(html, /id="login-title"/);
  assert.doesNotMatch(html, /当前服务|login-server|login-capabilities|login-privacy/);
  assert.equal((html.match(/凭据只发送到本机 Wand 服务，不会保存在此页面。/g) ?? []).length, 1);
  assert.match(html, /id="password"[^>]*autofocus/);
  assert.match(html, /aria-describedby="password-hint login-error"/);
  assert.match(html, /id="login-error"[^>]*role="alert"/);
  assert.match(html, /id="login-cert-hint"/);
  assert.ok(html.indexOf('id="login-cert-hint"') > html.indexOf('id="login-button"'));
});

test("motion has a keyboard-accessible pause, a static reduced-motion view, and no mobile footprint", () => {
  const html = renderLoginVisual("");
  assert.match(html, /id="login-visual-paused"[^>]+type="checkbox"\s+aria-label="暂停插画动效"/);
  assert.match(html, /for="login-visual-paused"/);
  assert.match(styles, /\.login-visual-toggle:focus-visible \+ \.login-visual-control\s*\{[^}]+outline:/);
  assert.match(styles, /\.login-visual-toggle:checked ~ \.login-visual-scene \*\s*\{ animation-play-state: paused;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.login-visual-scene \*\s*\{ animation: none !important;/);
  assert.match(styles, /@media \(max-width: 640px\)\s*\{[^@]+\.login-page \.left-spacer \{ display: none; \}/);
  assert.match(styles, /\.login-visual-control > svg \{[^}]+transition: opacity var\(--motion-morph\)/);
  assert.match(styles, /\.login-visual-control > svg \{ transition: none; \}/);
});
