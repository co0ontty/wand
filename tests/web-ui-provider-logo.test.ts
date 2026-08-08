import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  inferProviderIdFromCommand,
  normalizeProviderId,
  providerDisplayName,
  PROVIDER_IDS,
  renderProviderLogoMarkup,
} from "../src/web-ui/provider-identity.js";
import { ProviderLogo } from "../src/web-ui/react/provider-logo.js";

test("ProviderLogo renders a distinct local brand mark for every supported provider", () => {
  const rendered = PROVIDER_IDS.map((provider) => {
    const html = renderToStaticMarkup(createElement(ProviderLogo, { provider }));
    assert.match(html, new RegExp(`data-provider-logo="${provider}"`));
    assert.match(html, /^<svg/);
    assert.doesNotMatch(html, />[CO]<\/svg>/);
    return html;
  });

  assert.equal(new Set(rendered).size, PROVIDER_IDS.length);
  assert.match(rendered[2], /fill="#131010"/);
  assert.match(rendered[4], /fill="#2ADB5C"/);
  assert.match(rendered[5], /viewBox="0 0 800 800"/);
  assert.match(rendered[5], /fill-rule="evenodd"/);
  assert.match(rendered[5], /M517\.36 400H634\.72V634\.72H517\.36Z/);
});

test("provider identity normalizes legacy executable names and keeps display labels consistent", () => {
  assert.equal(normalizeProviderId("codex-cli-exec"), "codex");
  assert.equal(normalizeProviderId("grok-cli-headless"), "grok");
  assert.equal(normalizeProviderId("custom-agent"), null);
  assert.equal(inferProviderIdFromCommand("/opt/homebrew/bin/claude --resume abc"), "claude");
  assert.equal(inferProviderIdFromCommand("open-code run"), "opencode");
  assert.equal(inferProviderIdFromCommand("qodercli --print"), "qoder");
  assert.equal(inferProviderIdFromCommand("claude -p codex"), "claude");
  assert.equal(inferProviderIdFromCommand("/tmp/opencode-tools/bin/claude --resume abc"), "claude");
  assert.equal(providerDisplayName("qoder"), "Qoder");
  assert.equal(providerDisplayName("custom-agent"), "custom-agent");
  assert.match(renderProviderLogoMarkup("opencode"), /data-provider-logo="opencode"/);
  assert.match(renderProviderLogoMarkup("pi"), /viewBox="0 0 800 800"/);
});
