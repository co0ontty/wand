import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPiSessionSettings, NO_PI_SETTINGS_CONTROLS, piSettingsControls, type PiSettingsResponse } from "../src/pi-session-settings.js";
import { PiSettingsController, type PiSettingsMount } from "../src/web-ui/react/pi-settings/controller.js";
import { panelNotes, PiSettingsPanel } from "../src/web-ui/react/pi-settings/host.js";
import { piSettingsRepository } from "../src/web-ui/react/pi-settings/repository.js";
import { PiSkillSwitch } from "../src/web-ui/react/pi-settings/skill-switch.js";

const target = {} as HTMLElement;
const toggleTarget = {} as HTMLElement;
function mount(sessionId = "pi-a", overrides: Partial<PiSettingsMount> = {}): PiSettingsMount {
  return { key: "pi-settings", target, toggleTarget, sessionId, draft: "/", open: true,
    onSaved() {}, returnFocus() {}, ...overrides };
}
function response(overrides: Partial<PiSettingsResponse> = {}): PiSettingsResponse {
  return { settings: defaultPiSessionSettings(), available: false, reason: "Pi 主功能固定使用 CLI JSON",
    engine: "cli", toolsAvailable: true, goalAvailable: true, globalExtensions: [], localDecisionAvailable: true,
    controls: { ...NO_PI_SETTINGS_CONTROLS, tools: true, codemode: true, globalTools: true }, ...overrides };
}

test("Pi settings controller is idempotent; dismiss/focus stay bound to the mounted session", () => {
  const controller = new PiSettingsController();
  const a = mount();
  controller.sync([a]);
  const snapshot = controller.getSnapshot();
  controller.sync([{ ...a }]);
  assert.equal(controller.getSnapshot(), snapshot);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.mounts));
  const focused: boolean[] = [];
  const unregister = controller.registerFocus(a, (last) => focused.push(last));
  controller.focusControl();
  controller.focusControl(true);
  assert.deepEqual(focused, [false, true]);
  controller.dismiss();
  assert.equal(controller.isDismissed(a.sessionId, "/"), true);
  assert.equal(controller.isDismissed(a.sessionId, "/tools"), false);
  controller.focusControl();
  assert.equal(focused.length, 2, "closed controls must not receive focus");
  controller.reopen();
  assert.equal(controller.isDismissed(a.sessionId, "/"), false);
  controller.sync([mount("pi-b")]);
  controller.focusControl();
  assert.equal(focused.length, 2, "old focus callback cannot affect another session");
  unregister();
  controller.clear();
  assert.deepEqual(controller.getSnapshot().mounts, []);
});

test("输入框里的设置图标是显式展开态：与草稿无关，切换会话后不重放", () => {
  const controller = new PiSettingsController();
  const closed = mount("pi-a", { open: false });
  controller.sync([closed]);
  assert.equal(controller.toggle("pi-a"), true, "图标点击应展开");
  assert.equal(controller.isExpanded("pi-a"), true);
  assert.equal(controller.openedBy(), "toggle");
  assert.equal(controller.hasPendingFocus(), true, "展开后需要把焦点送进面板");
  // 设置还在读取时控件都禁用：聚焦没成功就不能把请求丢掉，否则键盘用户永远进不去。
  const a = controller.getSnapshot().mounts[0];
  const release = controller.registerFocus(a, () => false);
  assert.equal(controller.focusControl(), false);
  assert.equal(controller.hasPendingFocus(), true);
  release();
  const released = controller.getSnapshot().mounts[0];
  const release2 = controller.registerFocus(released, () => true);
  assert.equal(controller.focusControl(), true);
  controller.clearPendingFocus();
  assert.equal(controller.hasPendingFocus(), false);
  release2();
  assert.equal(controller.getSnapshot().mounts[0].open, true);
  // 打字（草稿变化）不改变展开态：面板仍开着，且不是靠草稿条件撑住的。
  controller.sync([{ ...closed, draft: "边写边改工具", open: controller.isExpanded("pi-a") }]);
  assert.equal(controller.getSnapshot().mounts[0].open, true);
  assert.equal(controller.toggle("pi-a"), false, "再点图标应原位收起");
  assert.equal(controller.isExpanded("pi-a"), false);
  assert.equal(controller.getSnapshot().mounts[0].open, false);
  // 图标展开后切到另一个会话：展开态不能跟过去（否则新会话一进来就弹面板）。
  controller.toggle("pi-a");
  controller.sync([mount("pi-b", { open: false })]);
  assert.equal(controller.isExpanded("pi-a"), false);
  assert.equal(controller.isExpanded("pi-b"), false);
  // 输入 `/settings` 展开时来源记作草稿：收起后焦点回输入框而不是图标。
  const draftMount = mount("pi-a", { open: false });
  controller.sync([draftMount]);
  controller.reopen();
  assert.equal(controller.openedBy(), "draft");
  assert.equal(controller.getSnapshot().mounts[0].open, true);
});

test("关闭重开代次识别同会话 ABA，不依赖 React 中间帧", () => {
  const controller = new PiSettingsController();
  controller.sync([mount("pi-a", { open: false })]);
  controller.toggle("pi-a");
  const first = controller.getSnapshot().mounts[0].openRevision;
  controller.dismiss(); controller.toggle("pi-a");
  assert.ok(controller.getSnapshot().mounts[0].openRevision! > first!);
  assert.equal(controller.getSnapshot().mounts[0].open, true);
});

test("Pi settings panel keeps feedback inline, closed controls inert and all options visible", () => {
  const markup = renderToStaticMarkup(React.createElement(PiSettingsPanel, { mount: { ...mount(), open: false } }));
  for (const label of ["Skills", "MCP", "搜索 Skills / MCP"]) assert.ok(markup.includes(label));
  assert.doesNotMatch(markup, /基础工具|全局扩展工具/);
  assert.match(markup, /CodeMode 模式/);
  assert.match(markup, /id="wand-pi-settings-panel-pi-a"/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /inert=""/);
  assert.doesNotMatch(markup, /工具白名单/);
  // 面板不再是「只能靠 /settings 打开」的浮层，标题里不再重复命令名。
  assert.doesNotMatch(markup, /\/settings · /);
  assert.match(markup, /disabled=""/);
});

test("Skill three-stage switch exposes all detents with library visuals and one slider interaction owner", () => {
  for (const [index, mode] of ["off", "on", "locked"].entries()) {
    const markup = renderToStaticMarkup(React.createElement(PiSkillSwitch, {
      name: "subagent", mode: mode as "off" | "on" | "locked", disabled: false, onModeChange: async () => true,
    }));
    assert.match(markup, /role="slider"/);
    assert.ok(markup.includes(`aria-valuenow="${index}"`));
    assert.match(markup, /aria-valuemax="2"/);
    assert.match(markup, /ant-segmented/);
    assert.match(markup, new RegExp(`data-wand-icon="${mode === "locked" ? "lock" : "unlock"}"`));
    assert.match(markup, /inert=""/, "library radio visuals do not introduce extra focus stops inside the slider");
    assert.match(markup, /关/); assert.match(markup, /开/);
    assert.doesNotMatch(markup, /type="checkbox"/);
  }
  const disabled = renderToStaticMarkup(React.createElement(PiSkillSwitch, {
    name: "subagent", mode: "locked", disabled: true, onModeChange: async () => false,
  }));
  assert.match(disabled, /aria-disabled="true"/);
  assert.match(disabled, /tabindex="-1"/);
});

test("panel notes describe resource isolation and never claim filesystem sandboxing", () => {
  assert.ok(panelNotes(response()).some((note) => note.includes("更新服务端")));
  const selected = response({ settings: { ...defaultPiSessionSettings(), resources: { skills: [], mcpServers: [] } },
    resourceCatalog: { skills: [], mcpServers: [], supported: true, reason: "" } });
  assert.ok(panelNotes(selected).some((note) => note.includes("基础工具保持现有配置")));
  assert.ok(panelNotes(selected).some((note) => note.includes("不是文件系统沙箱")));
  assert.ok(panelNotes(selected).some((note) => note.includes("旧会话历史")));
  assert.ok(panelNotes({ ...selected, settings: defaultPiSessionSettings() }).some((note) => note.includes("仍沿用 Pi 自动发现")));
  assert.deepEqual(panelNotes(null), []);
});

test("逐项可用性：新服务端按 controls，旧服务端退回它当时真实支持的能力", () => {
  assert.deepEqual(piSettingsControls(null), NO_PI_SETTINGS_CONTROLS);
  const cli = response();
  assert.equal(piSettingsControls(cli), cli.controls, "有 controls 时原样采用");
  // 旧 CLI 服务端：只有基础工具列表可用，CodeMode/全局扩展/目标模式一律不可改。
  const legacyCli = { available: false, toolsAvailable: true, goalAvailable: true, localDecisionAvailable: true };
  assert.deepEqual(piSettingsControls(legacyCli), { tools: true, codemode: false, codemodeOnly: false,
    globalTools: false, goalMode: false, localDecision: false, autoCompaction: false });
  // 旧 SDK 服务端：原生开关按它当时的语义开放。
  const legacySdk = { available: true, toolsAvailable: false, goalAvailable: false, localDecisionAvailable: true };
  assert.deepEqual(piSettingsControls(legacySdk), { tools: true, codemode: true, codemodeOnly: true,
    globalTools: true, goalMode: false, localDecision: true, autoCompaction: true });
});

test("Pi settings repository uses encoded session endpoints, partial patches and abortable requests", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let fail = false;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(fail ? { error: "真实保存失败" } : { settings: defaultPiSessionSettings() }),
      { status: fail ? 500 : 200, headers: { "Content-Type": "application/json" } });
  };
  const controller = new AbortController();
  await piSettingsRepository.load("id/with space", controller.signal);
  assert.equal(calls[0].url, "/api/sessions/id%2Fwith%20space/pi-settings");
  assert.equal(calls[0].init?.signal, controller.signal);
  await piSettingsRepository.save("pi-a", { codemode: "only" }, controller.signal);
  assert.equal(calls[1].init?.method, "PATCH");
  assert.equal(calls[1].init?.body, '{"codemode":"only"}');
  assert.equal(calls[1].init?.credentials, "same-origin");
  fail = true;
  await assert.rejects(piSettingsRepository.save("pi-a", { globalTools: true }, controller.signal), /真实保存失败/);
  globalThis.fetch = async () => { throw new DOMException("cancelled", "AbortError"); };
  await assert.rejects(piSettingsRepository.load("pi-a", controller.signal), { name: "AbortError" });
});

test("Pi settings React modules stay behind refs/runtime and repository seams", () => {
  for (const file of ["host.tsx", "controller.ts"]) {
    const source = readFileSync(new URL(`../src/web-ui/react/pi-settings/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|\.\s*(?:getElementById|querySelector(?:All)?)\s*(?:<[^>]*>)?\s*\(/);
  }
  // 图标与面板共用同一个 mount：宿主必须同时接两个落点，不能再各存一份开关状态。
  const host = readFileSync(new URL("../src/web-ui/react/pi-settings/host.tsx", import.meta.url), "utf8");
  assert.match(host, /mount\.toggleTarget/);
  assert.match(host, /aria-expanded=\{open\}/);
});

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("real Chrome Pi slash settings preserve composer and handle saving, keyboard and scope", {
  timeout: 180_000,
}, async (t) => {
  // 浏览器回归默认关闭：本地 npm test 只跑单测；CI（和需要时手动）用 WAND_BROWSER_E2E=1 打开。
  if (process.env.WAND_BROWSER_E2E !== "1" || !existsSync(chrome)) {
    t.skip("set WAND_BROWSER_E2E=1 and install Google Chrome to run the Chrome CDP Pi settings regression");
    return;
  }
  const { stdout } = await promisify(execFile)(process.execPath, [
    new URL("./helpers/run-pi-settings-browser-harness.mjs", import.meta.url).pathname,
  ], { timeout: 170_000, maxBuffer: 2 * 1024 * 1024 });
  assert.match(stdout, /Pi slash\/settings browser checks passed:/);
  assert.match(stdout, /reduce-motion 无位移动画/);
  assert.match(stdout, /图标展开后焦点进面板/);
  assert.match(stdout, /仅资源选择不改变通用工具/);
  assert.match(stdout, /再点图标原位收起并归还焦点/);
});
