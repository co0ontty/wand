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
import * as catCoats from "../src/web-ui/react/ai-teams/cat-coats.js";

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
    assert.equal((html.match(/class="wand-employee-avatar-provider"/g) ?? []).length, 1);
    assert.ok(html.indexOf("wand-employee-avatar-provider") > html.indexOf("</svg></span>"), "badge is not clipped by face");
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

test("contact presence indicator remains visible without covering the CLI badge", () => {
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.im-sidebar-item-avatar-wrap:has\(\.wand-employee-avatar-provider\) > \.im-sidebar-presence-dot \{\s*top: -2px;\s*bottom: auto;/);
});

function legacyAvatar(provider: string, avatar = employee.avatar): string {
  const exports: Record<string, any> = {};
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  const code = ts.transpileModule(source + `
    export function employeeAvatarFixture() { return chatAvatar("assistant"); }
  `, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, {
    exports,
    require: (id: string) => {
      if (id === "./state") return { state: { selectedId: "s_cli", sessions: [{
        id: "s_cli", employeeId: employee.id, employeeName: employee.name, employeeAvatar: avatar, provider,
      }] } };
      if (id === "../react/agents/employee-identity.js") return { renderEmployeeCliBadge };
      if (id === "../react/agents/employee-repository.js") return { cachedSiliconEmployee: () => null, subscribeSiliconEmployeeCache: noop };
      if (id === "../react/ai-teams/cat-coats") return catCoats;
      if (id === "./utils") return { escapeHtml: (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") };
      return fallback;
    },
    window: { matchMedia: () => ({ matches: false }) }, document: { addEventListener: noop },
    setTimeout: noop, clearTimeout: noop,
  });
  return exports.employeeAvatarFixture();
}

test("ordinary chat renderer badges the actual CLI even after employee deletion", () => {
  assert.match(legacyAvatar("pi"), /pixel-avatar wand-employee-avatar/);
  assert.match(legacyAvatar("pi"), /data-provider-logo="pi"/);
  const changed = legacyAvatar("codex", "data:image/png;base64,AAA");
  assert.match(changed, /data-provider-logo="codex"/);
  assert.match(changed, /src="data:image\/png;base64,AAA"/);
  assert.doesNotMatch(legacyAvatar("future-cli"), /data-provider-logo/);
  assert.match(source, /employee: \[session\.employeeId, session\.employeeName, session\.employeeAvatar, session\.provider\]/,
    "provider change invalidates cached avatar rows");
});
