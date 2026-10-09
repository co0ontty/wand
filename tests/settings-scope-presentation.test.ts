import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentToolDisplayName } from "../src/web-ui/provider-identity.js";
import { SettingsTextInput } from "../src/web-ui/react/settings/fields.js";
import { SystemAiOwnerSummary } from "../src/web-ui/react/settings/system-ai-owner.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";

test("execution labels distinguish CLI and SDK without changing provider identity", () => {
  assert.equal(agentToolDisplayName("pi", "cli"), "Pi");
  assert.equal(agentToolDisplayName("pi", "sdk"), "Wand Agent");
  assert.equal(agentToolDisplayName("pi", "core"), "Wand Agent");
  assert.equal(agentToolDisplayName("codex", "cli"), "Codex");
  const employee = { id: "fixture", name: "系统运维", avatar: "", agents: [
    { provider: "pi", engine: "sdk", model: "fixture-sdk" },
    { provider: "pi", engine: "cli", model: "fixture-cli" },
  ] } as SiliconEmployee;
  const html = renderToStaticMarkup(React.createElement(SystemAiOwnerSummary, { employee }));
  assert.match(html, /Wand Agent.*fixture-sdk/);
  assert.match(html, /Pi.*fixture-cli/);
});

test("secret fields are masked initially and offer a named keyboard-accessible reveal control", () => {
  const html = renderToStaticMarkup(React.createElement(SettingsTextInput, { id: "fixture-secret", type: "password",
    value: "", onChange: () => {}, autoComplete: "new-password" }));
  assert.match(html, /type="password"/);
  assert.match(html, /aria-label="显示敏感内容"/);
  assert.match(html, /aria-controls="fixture-secret"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /type="button"/);
});

test("an empty loaded system employee is not presented as perpetual loading", () => {
  const html = renderToStaticMarkup(React.createElement(SystemAiOwnerSummary, { employee: { id: "fixture", name: "系统运维", avatar: "", agents: [] } as unknown as SiliconEmployee }));
  assert.match(html, /尚未配置执行候选/);
  assert.doesNotMatch(html, /正在读取执行候选/);
});
