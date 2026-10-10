import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { employeeAvatarProvider, renderEmployeeCliBadge } from "../src/web-ui/react/agents/employee-identity.js";
import { PROVIDER_IDS } from "../src/web-ui/provider-identity.js";
import { EmployeeAvatar } from "../src/web-ui/react/agents/employee-avatar.js";
import { SidebarEmployeeAvatar } from "../src/web-ui/react/workspaces/sidebar-employee-avatar.js";

const employee = { id: "e_cli", name: "员工", avatar: "cat:2", agents: [{ provider: "codex" }, { provider: "pi" }] };
const source = readFileSync(new URL("../src/web-ui/browser/chat-render.ts", import.meta.url), "utf8");

test("employee avatar uses the preferred CLI only without an actual session provider", () => {
  assert.equal(employeeAvatarProvider(employee), "codex");
  assert.equal(employeeAvatarProvider(employee, "pi"), "pi", "fallback executor wins over current employee definition");
  assert.equal(employeeAvatarProvider(employee, "qoder-cli-print"), "qoder");
  for (const provider of ["", "terminal", "future-cli"]) {
    assert.equal(employeeAvatarProvider(employee, provider), null, "unknown actual CLI must not show the preferred logo");
  }
  assert.equal(employeeAvatarProvider({}), null, "avatar picker previews have no invented CLI");
});

test("all supported CLI logos appear as one badge outside the avatar face", () => {
  for (const provider of PROVIDER_IDS) {
    const html = renderToStaticMarkup(createElement(EmployeeAvatar, { employee, provider, size: "sm" }));
    assert.match(html, /wand-team-avatar wand-employee-avatar/);
    assert.match(html, /data-size="sm"/);
    assert.match(html, new RegExp(`data-provider-logo="${provider}"`));
    assert.equal((html.match(/class="[^"]*\bwand-employee-avatar-provider\b[^"]*"/g) ?? []).length, 1);
    assert.match(html, /ant-badge/);
    assert.match(html, /ant-avatar-square/);
    assert.ok(html.indexOf("wand-employee-avatar-provider") > html.indexOf("</svg></span>"), "library badge is outside the avatar face");
    assert.match(html, /role="img" aria-label="[^\"]+ CLI"/);
    assert.match(renderEmployeeCliBadge(provider), new RegExp(`data-provider-logo="${provider}"`));
  }
});

test("uploaded employee avatars retain their image and missing CLI has no generic badge", () => {
  const upload = { ...employee, avatar: "data:image/png;base64,AAA" };
  const html = renderToStaticMarkup(createElement(EmployeeAvatar, { employee: upload }));
  assert.match(html, /src="data:image\/png;base64,AAA"/);
  assert.match(html, /data-provider-logo="codex"/);
  const noCli = renderToStaticMarkup(createElement(EmployeeAvatar, { employee: upload, provider: "terminal" }));
  assert.doesNotMatch(noCli, /wand-employee-avatar-provider|data-provider-logo/);
  assert.equal(renderEmployeeCliBadge('unknown" onclick="evil'), "");
});

test("an SDK employee badge identifies Wand Agent rather than Pi CLI", () => {
  const sdkEmployee = { ...employee, agents: [{ provider: "pi", engine: "sdk" as const }] };
  const html = renderToStaticMarkup(createElement(EmployeeAvatar, { employee: sdkEmployee }));
  assert.match(html, /aria-label="Wand Agent"/);
  assert.doesNotMatch(html, /aria-label="Pi CLI"/);
});

test("recent sidebar employee avatars show identity without a preferred CLI badge", () => {
  for (const avatar of ["", "cat:2", "data:image/png;base64,AAA"]) {
    for (const agents of [[], [{ provider: "codex" }], employee.agents]) {
      const html = renderToStaticMarkup(createElement(SidebarEmployeeAvatar, {
        employee: { ...employee, avatar, agents },
      }));
      assert.match(html, /wand-employee-avatar/);
      assert.doesNotMatch(html, /wand-employee-avatar-provider|data-provider-logo/);
      if (avatar.startsWith("data:")) assert.ok(html.includes(avatar));
      else if (avatar.startsWith("cat:")) assert.match(html, /<svg/);
      else { assert.match(html, /data-plush-avatar/); assert.match(html, /data-avatar-config=/); assert.doesNotMatch(html, /wand-generated-avatar-glyph/); }
    }
  }
});

test("contact presence indicator remains visible without covering the CLI badge", () => {
  const component = readFileSync(new URL("../src/web-ui/react/shell/im-sidebar-item.tsx", import.meta.url), "utf8");
  assert.match(component, /data-glow=\{effectiveGlow\}/);
  assert.match(component, /<Badge dot=\{effectiveGlow !== "none"\} color=\{sidebarGlowColor\(effectiveGlow\)\}/);
  assert.match(component, /im-sidebar-item-avatar-wrap/);
  assert.doesNotMatch(component, /im-sidebar-presence-dot/);
});

function legacyReply(provider: string, avatar = employee.avatar): string {
  const exports: Record<string, any> = {};
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  const code = ts.transpileModule(source + `
    export function replyFixture() { return renderChatMessage({ role: "assistant", content: "通用会话回复" }, null, 0, {}, {}); }
  `, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, {
    exports,
    require: (id: string) => {
      if (id === "./state") return { state: { selectedId: "s_cli", sessions: [{
        id: "s_cli", employeeId: employee.id, employeeName: employee.name, employeeAvatar: avatar, provider,
      }] } };
      if (id === "../markdown.js") return { renderChatMarkdown: (value: string) => value };
      if (id === "./utils") return { escapeHtml: (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") };
      return fallback;
    },
    window: { matchMedia: () => ({ matches: false }) }, document: { addEventListener: noop },
    setTimeout: noop, clearTimeout: noop,
  });
  return exports.replyFixture();
}

test("session transcript stays generic with or without employee identity and actual provider changes", () => {
  for (const provider of ["pi", "codex", "future-cli"]) {
    for (const avatar of ["", "cat:2", "data:image/png;base64,AAA"]) {
      const html = legacyReply(provider, avatar);
      assert.match(html, /通用会话回复/);
      assert.doesNotMatch(html, /employee|avatar|负责人|员工|查看.*资料/);
    }
  }
  const topbar = readFileSync(new URL("../src/web-ui/react/shell/shell-topbar.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(topbar, /ObjectProfilePanel|EmployeeAvatar|useSiliconEmployees/);
  assert.match(topbar, /snapshot\.topbar\.title/);
});

test("contact avatars still support generated faces, explicit cats and uploaded images outside sessions", () => {
  const generated = renderToStaticMarkup(createElement(EmployeeAvatar, { employee: { ...employee, avatar: "" } }));
  assert.match(generated, /wand-employee-avatar/);
  assert.match(generated, /data-plush-avatar/);
  const chosen = renderToStaticMarkup(createElement(EmployeeAvatar, { employee }));
  assert.match(chosen, /<svg/);
  const uploaded = renderToStaticMarkup(createElement(EmployeeAvatar, { employee: { ...employee, avatar: "data:image/png;base64,BBB" } }));
  assert.match(uploaded, /data:image\/png;base64,BBB/);
});
