import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderApp } from "../src/web-ui/index.js";
import { isStandaloneSettingsPage } from "../src/web-ui/page.js";
import { SettingsHost } from "../src/web-ui/react/settings/host.js";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the dedicated settings HTML declares page mode before the shared browser entry executes", () => {
  const html = renderApp("/tmp/wand-settings-page/config.json", "settings");
  assert.match(html, /<html lang="zh-CN" data-wand-page="settings" data-wand-settings-auth="browser">/);
  assert.match(html, /<title>Wand 设置<\/title>/);
  assert.match(html, /src="\/assets\/app\.js\?v=/);
  assert.doesNotMatch(html, /settings-button|trigger\.click|MutationObserver/);
  assert.doesNotMatch(renderApp("/tmp/wand-settings-page/config.json"), /data-wand-page="settings"/);
  assert.match(source("src/server.ts"), /app\.get\(\["\/", "\/settings"\]/);
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

test("the profile tab is the first admin section and reuses the shared avatar picker", () => {
  const host = source("src/web-ui/react/settings/host.tsx");
  assert.match(source("src/web-ui/react/settings/navigation.tsx"), /profile: \{ label: "我的资料"/, "分组标签有名字");
  assert.match(host, /const ADMIN_TAB_ORDER: SettingsTab\[\] = \[\s*"profile",/, "管理员进设置先看到自己的资料");
  assert.match(host, /profile: <ProfileSettingsTab \{\.\.\.props\} \/>/);
  const tabs = source("src/web-ui/react/settings/tabs.tsx");
  assert.match(tabs, /export function ProfileSettingsTab\(/);
  assert.match(tabs, /<EmployeeAvatarPicker[\s\S]{0,200}avatar=\{value\.avatar\}/, "头像复用员工选择器，不另造一套");
  assert.match(tabs, /type: "profile\.save", value/, "保存走语义命令");
  assert.match(tabs, /placeholder=\{DEFAULT_USER_DISPLAY_NAME\}/, "留空时提示默认署名");
});
