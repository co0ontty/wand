import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import express from "express";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { registerAssetRoutes } from "../src/server-asset-routes.js";
import { renderApp } from "../src/web-ui/index.js";
import { isStandaloneSettingsPage } from "../src/web-ui/page.js";
import { AuthService } from "../src/auth.js";
import { WandStorage } from "../src/storage.js";
import { SettingsHost } from "../src/web-ui/react/settings/host.js";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the dedicated settings HTML declares page mode before the shared browser entry executes", async (t) => {
  const html = renderApp("/tmp/wand-settings-page/config.json", "settings");
  assert.match(html, /<html lang="zh-CN" data-wand-page="settings" data-wand-settings-auth="browser">/);
  assert.match(html, /<title>Wand 设置<\/title>/);
  assert.match(html, /src="\/assets\/app\.js\?v=/);
  assert.doesNotMatch(html, /settings-button|trigger\.click|MutationObserver/);
  assert.doesNotMatch(renderApp("/tmp/wand-settings-page/config.json"), /data-wand-page="settings"/);
  const app = express();
  // 匿名访客只拿登录小包，所以这里要给出一个真实可用的 AuthService 实例；
  // 没有会话时 `/` 与 `/settings` 都按匿名页下发，正是本次拆分的目标行为。
  const storage = new WandStorage(path.join(os.tmpdir(), `wand-settings-page-${process.pid}-${Date.now()}.db`));
  t.after(() => storage.close());
  registerAssetRoutes(app, {
    configPath: "/tmp/wand-settings-page/config.json",
    config: defaultConfig(),
    requireAuth: (_req, _res, next) => next(),
    requireSessions: (_req, _res, next) => next(),
    authService: new AuthService(storage),
    useHttps: false,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (const [route, page] of [["/settings", "settings"], ["/", "console"]]) {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.equal(html.includes('data-wand-page="settings"'), page === "settings");
    // 未登录时不预载控制台 runtime，只下发登录小包。
    assert.match(html, /\/assets\/login\.js\?v=/);
    assert.doesNotMatch(html, /rel="modulepreload"/);
  }
});

test("standalone detection is safe outside a browser and uses the explicit page contract", () => {
  assert.equal(isStandaloneSettingsPage(), false);
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: { wandPage: "settings" } } } });
    assert.equal(isStandaloneSettingsPage(), true);
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: { wandPage: "console" } } } });
    assert.equal(isStandaloneSettingsPage(), false);
  } finally {
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("page presentation is always visible without a controller open or a modal wrapper", () => {
  const html = renderToStaticMarkup(React.createElement(SettingsHost, { presentation: "page" }));
  assert.match(html, /<main[^>]*data-testid="settings-page"/);
  assert.match(html, /系统设置/);
  assert.doesNotMatch(html, /settings-dialog|ant-modal|role="dialog"|关闭设置/);
});

test("page mode bypasses home bootstrap and only mounts settings plus its supporting overlays", () => {
  const render = source("src/web-ui/browser/render.ts");
  for (const signature of ["renderBootLoading()", "restoreLoginSession()", "render(options?: any)"]) {
    assert.ok(render.includes(`export function ${signature} {\n  if (isStandaloneSettingsPage()) return;`));
  }
  assert.match(source("src/web-ui/react/index.tsx"), /settingsPresentation=\{standaloneSettings \? "page" : "workspace"\}/);
  assert.match(source("src/web-ui/react/overlay-host.tsx"), /settingsPresentation === "workspace" \? <>/);
  const css = source("src/web-ui/content/styles.css");
  assert.match(css, /\.wand-settings-library-page \{[^}]*inset:0;[^}]*overflow:hidden;[^}]*pointer-events:auto/);
});

test("an expired page session offers admin login in place and never navigates back to home", () => {
  const host = source("src/web-ui/react/settings/host.tsx");
  assert.match(host, /presentation === "page" && \(error as Error & \{ status\?: number \}\)\.status === 401/);
  assert.match(host, /loginRequired && !clientAuth \? <div className="wand-settings-library-page-content">[\s\S]*?<ConnectedAppAccess repository=\{repository\} signedOut allowEmptyPassword/);
  assert.match(host, /setLoginRequired\(false\)/);
  assert.doesNotMatch(host, /window\.location|location\.href|settings-button|trigger\.click/);
  assert.match(host, /snapshot\.access === "read-only" && !loginRequired && !clientAuth/);
  assert.match(renderApp("/tmp/wand-settings-page/config.json", "settings", "client"), /data-wand-settings-auth="client"/);
});

test("employees stay first, default to my profile and share the identity avatar editor", () => {
  const host = source("src/web-ui/react/settings/host.tsx");
  assert.match(source("src/web-ui/react/settings/navigation.tsx"), /profile: \{ label: "我的信息"/, "分组标签有名字");
  assert.match(host, /const ADMIN_TAB_ORDER: SettingsTab\[\] = \[\s*"profile",/, "管理员进设置先看到自己的资料");
  assert.match(host, /profile: <EmployeesSettingsTab \{\.\.\.props\} \/>/);
  const tabs = source("src/web-ui/react/settings/tabs.tsx");
  assert.match(tabs, /export function ProfileSettingsTab\(/);
  assert.match(tabs, /<UserAvatarPicker[\s\S]{0,200}avatar=\{value\.avatar\}/, "个人资料保留其支持的头像格式");
  const picker = source("src/web-ui/react/agents/user-avatar-picker.tsx");
  assert.match(picker, /<EmployeeAvatarPicker \{\.\.\.props\} employeeId="user"/);
  const panel = source("src/web-ui/react/settings/employees-panel.tsx");
  assert.match(panel, /<EmployeeListPage/);
  assert.match(panel, /renderSelf=/);
  assert.doesNotMatch(source("src/web-ui/react/settings/styles.ts"), /\.ant-menu-root[^}]*grid-template-columns/, "设置导航不再分三列");
  assert.match(tabs, /type: "profile\.save", value/, "保存走语义命令");
  assert.match(tabs, /placeholder=\{DEFAULT_USER_DISPLAY_NAME\}/, "留空时提示默认署名");
});
