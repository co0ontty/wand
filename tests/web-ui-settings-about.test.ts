import assert from "node:assert/strict";
import test from "node:test";

import {
  cliStatusDetail,
  cliStatusText,
  cliUpdateSummary,
  modelCatalogSummary,
} from "../src/web-ui/react/settings/tabs.tsx";
import type {
  SettingsModelCatalog,
  SettingsProviderCliStatus,
  SettingsProviderCliUpdates,
} from "../src/web-ui/react/settings/types.ts";

function cliStatus(overrides: Partial<SettingsProviderCliStatus> = {}): SettingsProviderCliStatus {
  return {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    executable: "/opt/homebrew/bin/claude",
    installed: true,
    currentVersion: "2.1.149",
    latestVersion: "2.1.277",
    updateAvailable: true,
    updateSupported: true,
    installKind: "brew",
    ...overrides,
  };
}

test("CLI rows distinguish up-to-date, unreadable, and missing CLIs", () => {
  assert.equal(cliStatusText(cliStatus()), "2.1.149 → 2.1.277");
  assert.equal(cliStatusText(cliStatus({ updateSupported: false })), "2.1.149 → 2.1.277（需手动更新）");
  assert.equal(
    cliStatusText(cliStatus({ updateAvailable: false, latestVersion: "2.1.149" })),
    "2.1.149（已是最新）",
  );
  assert.equal(
    cliStatusText(cliStatus({ updateAvailable: false, latestVersion: null })),
    "2.1.149（未能获取最新版）",
  );
  assert.equal(
    cliStatusText(cliStatus({ updateAvailable: false, currentVersion: null })),
    "版本读取失败",
  );
  assert.equal(
    cliStatusText(cliStatus({ updateAvailable: false, installed: false, currentVersion: null, latestVersion: null, executable: null })),
    "未安装",
  );
  assert.equal(cliStatusDetail(cliStatus()), "2.1.149 → 2.1.277");
  assert.equal(
    cliStatusDetail(cliStatus({ error: "Command failed:\n  brew upgrade claude-code" })),
    "Command failed: brew upgrade claude-code",
  );
});

test("quick update reports every CLI result instead of a bare success", () => {
  const empty: SettingsProviderCliUpdates = { items: [], checkedAt: null, updating: false, autoUpdate: false };
  assert.deepEqual(cliUpdateSummary(empty), { ok: true, text: "没有需要更新的 CLI。" });

  const mixed: SettingsProviderCliUpdates = {
    ...empty,
    results: [
      { id: "claude", label: "Claude Code", ok: false, skipped: true, fromVersion: "2.1.267", toVersion: "2.1.277", message: "请运行 `brew upgrade claude-code` 更新。" },
      { id: "opencode", label: "OpenCode", ok: true, skipped: false, fromVersion: "1.18.0", toVersion: "1.18.31", message: "更新命令执行完成。" },
    ],
  };
  const summary = cliUpdateSummary(mixed);
  assert.equal(summary.ok, false);
  assert.match(summary.text, /^1\/2 个 CLI 未更新完成：/);
  assert.match(summary.text, /Claude Code：请运行 `brew upgrade claude-code` 更新。/);
  assert.match(summary.text, /OpenCode：更新命令执行完成。/);

  const allOk = cliUpdateSummary({ ...mixed, results: mixed.results?.filter((item) => item.ok) });
  assert.equal(allOk.ok, true);
  assert.match(allOk.text, /^1 个 CLI 更新完成：/);
});

test("model refresh summary lists every CLI, including empty catalogs", () => {
  const catalog = {
    models: [{ id: "default", label: "默认" }],
    codexModels: [],
    opencodeModels: [{ id: "default", label: "默认" }, { id: "gpt-5", label: "gpt-5" }],
    grokModels: [{ id: "default", label: "默认" }],
    qoderModels: [],
    piModels: [],
  } as unknown as SettingsModelCatalog;
  assert.equal(
    modelCatalogSummary(catalog),
    "Claude 1 · Codex 0（未发现） · OpenCode 2 · Grok 1 · Qoder 0（未发现） · Pi 0（未发现）",
  );
});
