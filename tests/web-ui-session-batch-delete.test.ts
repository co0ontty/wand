import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseJsonResponse } from "../src/web-ui/react/http-adapter.js";

async function tick(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function harness(responseBody: unknown, status = 200) {
  const state: Record<string, any> = {
    selectedSessionIds: { A: true, B: true },
    selectedClaudeHistoryIds: {},
    selectedCodexHistoryIds: {},
    sessionsManageMode: true,
    selectedId: "A",
    sessions: [{ id: "A" }, { id: "B" }],
  };
  const errors: string[] = [];
  let refreshes = 0;
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  const api: Record<string, any> = {};
  const source = readFileSync(new URL("../src/web-ui/browser/sidebar.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  runInNewContext(outputText, {
    exports: api,
    require: (id: string) => {
      if (id === "./state") return { state };
      if (id === "./chat-scroll") return { persistSelectedId: noop };
      if (id === "./notifications") return { wandConfirm: () => Promise.resolve(true) };
      if (id === "./composer-action-error") return { showActionError: (message: string) => errors.push(message) };
      if (id === "./session-engine") return {
        updateSessionsList: noop,
        refreshAll: () => { refreshes += 1; return Promise.resolve(); },
      };
      if (id === "../react/http-adapter") return { parseJsonResponse };
      if (id === "../../error-utils.js") return { getErrorMessage: (error: unknown, fallbackMessage: string) => error instanceof Error ? error.message : fallbackMessage };
      return fallback;
    },
    fetch: () => Promise.resolve(new Response(JSON.stringify(responseBody), { status })),
  });
  return { api, state, errors, get refreshes() { return refreshes; } };
}

test("batch delete does not clear selection or refresh after an HTTP failure", async () => {
  const h = harness({ error: "没有权限。" }, 403);
  h.api.batchDeleteSelected();
  await tick();
  assert.deepEqual(h.state.selectedSessionIds, { A: true, B: true });
  assert.equal(h.state.selectedId, "A");
  assert.equal(h.refreshes, 0);
  assert.deepEqual(h.errors, ["没有权限。"]);
});

test("batch delete only keeps failed sessions selected after a partial success", async () => {
  const h = harness({ ok: true, deleted: 1, failed: ["B"] });
  h.api.batchDeleteSelected();
  await tick();
  assert.equal(JSON.stringify(h.state.selectedSessionIds), JSON.stringify({ B: true }));
  assert.equal(h.state.selectedId, null, "成功删除当前会话后才取消当前选择");
  assert.equal(h.refreshes, 1);
  assert.deepEqual(h.errors, ["有 1 个会话未能删除，请重试。"]);
});
