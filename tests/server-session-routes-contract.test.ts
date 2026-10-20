import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerClaudeHistoryRoutes, registerSessionRoutes } from "../src/server-session-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { ContentBlock, SessionSnapshot } from "../src/types.js";

test("session HTTP interface preserves create, list, update, detail, and delete behavior", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-routes-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions });
  registerClaudeHistoryRoutes(app, processes, storage);
  app.use(jsonErrorHandler);
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "structured", cwd: root, provider: "opencode", mode: "assist" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; sessionKind: string; provider: string; output: string };
    assert.equal(created.sessionKind, "structured");
    assert.equal(created.provider, "opencode");
    assert.equal(created.output, "");
    assert.equal((await fetch(`${baseUrl}/api/sessions/${created.id}/pty-history?before=1&revision=0`)).status, 404);
    const structuredPage = await (await fetch(`${baseUrl}/api/sessions/${created.id}/messages`)).json() as {
      messages: unknown[]; offset: number; total: number;
    };
    assert.deepEqual(structuredPage, { wandProtocolVersion: 2, messages: [], offset: 0, total: 0 });
    const messages: NonNullable<SessionSnapshot["messages"]> = Array.from({ length: 90 }, (_, index) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `history-${index}` }],
    }));
    // get() returns detached snapshots. Inject the fixture transcript at the HTTP registry seam,
    // including mutation responses, without mutating a detached read or bypassing the real settings operations.
    const withHistory = (snapshot: SessionSnapshot | null): SessionSnapshot | null =>
      snapshot?.id === created.id ? { ...snapshot, messages } : snapshot;
    const originalGet = sessions.get.bind(sessions);
    sessions.get = (id: string) => withHistory(originalGet(id));
    const originalModel = sessions.setSessionModel.bind(sessions);
    sessions.setSessionModel = (...args) => withHistory(originalModel(...args));
    const originalThinking = sessions.setSessionThinkingEffort.bind(sessions);
    sessions.setSessionThinkingEffort = (...args) => withHistory(originalThinking(...args));
    const originalMode = sessions.setSessionMode.bind(sessions);
    sessions.setSessionMode = (...args) => withHistory(originalMode(...args));
    const originalStructuredGetSlim = structured.getSlim.bind(structured);
    structured.getSlim = (id: string) => {
      const snapshot = originalStructuredGetSlim(id);
      return snapshot?.id === created.id ? { ...snapshot, messages } : snapshot;
    };
    // The unified messages endpoint starts at zero unless an explicit cursor is supplied.
    const firstPageOfMessages = await (await fetch(`${baseUrl}/api/sessions/${created.id}/messages`)).json() as {
      messages: Array<{ content: Array<{ text?: string }> }>; offset: number; total: number;
    };
    assert.equal(firstPageOfMessages.offset, 0);
    assert.equal(firstPageOfMessages.messages.length, 40);
    assert.equal(firstPageOfMessages.messages[0].content[0].text, "history-0");
    assert.equal(firstPageOfMessages.total, 90);
    const tailPage = await (await fetch(`${baseUrl}/api/sessions/${created.id}/messages?offset=50`)).json() as typeof firstPageOfMessages;
    assert.equal(tailPage.messages.length, 40);
    assert.equal(tailPage.offset, 50);
    assert.equal(tailPage.total, 90);
    assert.equal(tailPage.messages[0].content[0].text, "history-50");
    const olderPage = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}/messages?offset=10&limit=5`,
    )).json() as typeof tailPage;
    assert.equal(olderPage.messages.length, 5);
    assert.equal(olderPage.messages[0].content[0].text, "history-10");
    const beforePage = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}/messages?before=90&blockBudget=12`,
    )).json() as typeof tailPage & { leadingBlockOffset: number };
    assert.equal(beforePage.messages.length, 12);
    assert.equal(beforePage.offset, 78);
    assert.equal(beforePage.total, 90);
    assert.equal(beforePage.leadingBlockOffset, 0);
    const getSession = sessions.get.bind(sessions);
    sessions.get = (id) => { const snapshot = getSession(id); return snapshot ? { ...snapshot, output: "duplicate transcript" } : snapshot; };
    const webDetail = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}?format=chat&blockBudget=12&byteBudget=98304&output=omit`,
    )).json() as typeof beforePage & { output: string; messageOffset: number; messageTotal: number };
    assert.equal(webDetail.messages.length, 12);
    assert.equal(webDetail.messageOffset, 78);
    assert.equal(webDetail.messageTotal, 90);
    assert.equal(webDetail.output, "", "Web chat omits only the duplicate structured transcript");
    const unchangedOutput = await (await fetch(`${baseUrl}/api/sessions/${created.id}?format=chat&blockBudget=60`)).json() as { output: string };
    assert.equal(unchangedOutput.output, "duplicate transcript", "non-opted clients keep the existing DTO");
    sessions.get = getSession;
    messages.push({ role: "assistant", content: Array.from({ length: 150 }, (_, index) =>
      ({ type: "text", text: `large-${index}` })) });
    const boundedPage = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}/messages?before=91&blockBudget=12`,
    )).json() as typeof beforePage;
    assert.equal(boundedPage.messages.length, 1);
    assert.equal(boundedPage.messages[0].content.length, 12);
    assert.equal(boundedPage.offset, 90);
    assert.equal(boundedPage.leadingBlockOffset, 138);
    assert.equal(boundedPage.messages[0].content[0].text, "large-138");
    messages.length = 0;

    // A long assistant turn contains many folded tool blocks between visible
    // paragraphs. Intra-turn Web pages must fill the visible budget rather
    // than spend a network round trip on every twelve raw blocks.
    const toolHeavy: ContentBlock[] = Array.from({ length: 24 }, (_, index) => [
      { type: "text" as const, text: `paragraph-${index}` },
      ...Array.from({ length: 8 }, (_, tool) => [
        { type: "tool_use" as const, id: `page-${index}-${tool}`, name: "Bash", input: { command: "true" } },
        { type: "tool_result" as const, tool_use_id: `page-${index}-${tool}`, content: "done" },
      ]).flat(),
    ]).flat();
    messages.push({ role: "assistant", content: toolHeavy });
    const pageCounts: number[] = [];
    for (const visible of [false, true]) {
      let offset = toolHeavy.length;
      let count = 0;
      const received: ContentBlock[] = [];
      while (offset > 0) {
        const page = await (await fetch(`${baseUrl}/api/sessions/${created.id}/messages?turn=0`
          + `&blockOffset=${offset}&blockLimit=12&byteBudget=98304${visible ? "&blockBudget=12" : ""}`,
        { headers: { "X-Wand-Tool-Projection": "compact" } })).json() as {
          blocks: ContentBlock[]; blockOffset: number; blockTotal: number; turnIndex: number;
        };
        assert.equal(page.turnIndex, 0);
        assert.equal(page.blockTotal, toolHeavy.length);
        assert.ok(page.blockOffset < offset, "every page makes progress");
        assert.equal(page.blockOffset + page.blocks.length, offset, "pages are contiguous");
        received.unshift(...page.blocks);
        offset = page.blockOffset;
        count++;
        assert.ok(count <= toolHeavy.length);
      }
      assert.deepEqual(received.map(block => block.type === "text" ? block.text
        : block.type === "tool_use" ? block.id : block.type === "tool_result" ? block.tool_use_id : block.type),
      toolHeavy.map(block => block.type === "text" ? block.text
        : block.type === "tool_use" ? block.id : block.type === "tool_result" ? block.tool_use_id : block.type),
      "both pagination modes retain every source block in order");
      pageCounts.push(count);
    }
    assert.ok(pageCounts[0] > 12, "legacy raw-block pagination reproduces the request waterfall");
    assert.equal(pageCounts[1], 2, "Web batches folded metadata with twelve visible paragraphs per page");
    messages[0].content = Array.from({ length: 30 }, () => ({ type: "text", text: "x".repeat(20_000) }));
    const byteBounded = await (await fetch(`${baseUrl}/api/sessions/${created.id}/messages`
      + "?turn=0&blockOffset=30&blockLimit=12&blockBudget=12&byteBudget=98304")).json() as {
        blocks: ContentBlock[]; blockOffset: number;
      };
    assert.ok(byteBounded.blocks.length > 0 && byteBounded.blocks.length < 12,
      "byte budget still bounds pages with large visible blocks");
    assert.ok(JSON.stringify(byteBounded).length < 100_000);
    const emptyPage = await (await fetch(`${baseUrl}/api/sessions/${created.id}/messages`
      + "?turn=0&blockOffset=0&blockBudget=12")).json() as { blocks: ContentBlock[]; blockOffset: number };
    assert.deepEqual(emptyPage.blocks, []);
    assert.equal(emptyPage.blockOffset, 0);
    messages.length = 0;

    messages.push({ role: "assistant", content: [
      { type: "tool_use", id: "lazy-edit", name: "Edit", input: {
        file_path: "/repo/private.ts", old_string: "PRIVATE_OLD", new_string: "PRIVATE_NEW",
      } },
      { type: "tool_result", tool_use_id: "lazy-edit", content: "PRIVATE_RESULT" },
    ] });
    const legacyDetail = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}?format=chat&blockBudget=60`,
    )).json() as { messages: Array<{ content: Array<Record<string, any>> }> };
    assert.equal(legacyDetail.messages[0].content[0].input.old_string, "PRIVATE_OLD");
    assert.equal(legacyDetail.messages[0].content[1].content, "PRIVATE_RESULT");
    const compactHeaders = { "X-Wand-Tool-Projection": "compact" };
    const compactDetail = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}?format=chat&blockBudget=60`,
      { headers: compactHeaders },
    )).json() as typeof legacyDetail;
    assert.deepEqual(compactDetail.messages[0].content[0].input, {});
    assert.equal(compactDetail.messages[0].content[0].activity.kind, "edit_file");
    assert.equal(compactDetail.messages[0].content[1].content, "");
    assert.equal(compactDetail.messages[0].content[1]._truncated, true);
    assert.doesNotMatch(JSON.stringify(compactDetail.messages), /PRIVATE_OLD|PRIVATE_NEW|\/repo\/private\.ts/);
    assert.equal(compactDetail.messages[0].content[1].preview, "PRIVATE_RESULT");
    const compactPage = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}/messages?offset=0&limit=1`,
      { headers: compactHeaders },
    )).json() as { messages: Array<{ content: Array<Record<string, any>> }> };
    assert.deepEqual(compactPage.messages[0].content[0].input, {});
    const compactBlocks = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}/messages?turn=0&blockOffset=2&blockLimit=2`,
      { headers: compactHeaders },
    )).json() as { blocks: Array<Record<string, any>> };
    assert.deepEqual(compactBlocks.blocks[0].input, {});
    assert.equal(compactBlocks.blocks[1].content, "");
    const structuredPageCompact = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}/messages?offset=0&limit=1`,
      { headers: compactHeaders },
    )).json() as { messages: Array<{ content: Array<Record<string, any>> }> };
    assert.deepEqual(structuredPageCompact.messages[0].content[0].input, {});
    const complete = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}/tool-content/lazy-edit`,
      { headers: compactHeaders },
    )).json() as Record<string, any>;
    assert.equal(complete.input.old_string, "PRIVATE_OLD");
    assert.equal(complete.content, "PRIVATE_RESULT");
    assert.equal(complete.pending, false);
    assert.equal("tool_use" in complete, false);
    assert.equal("tool_result" in complete, false);
    messages.length = 0;
    messages.push({ role: "assistant", content: [
      { type: "tool_use", id: "pending-tool", name: "Bash", input: { command: "echo pending" } },
    ] });
    const pending = await (await fetch(
      `${baseUrl}/api/sessions/${created.id}/tool-content/pending-tool`,
      { headers: compactHeaders },
    )).json() as Record<string, any>;
    assert.equal(pending.input.command, "echo pending");
    assert.equal(pending.content, "");
    assert.equal(pending.pending, true);
    messages.length = 0;

    const listResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json() as Array<{ id: string; output: string }>;
    assert.deepEqual(listed.map((session) => session.id), [created.id]);
    assert.equal(listed[0].output, "");
    const usageResponse = await fetch(`${baseUrl}/api/sessions/provider-usage`);
    assert.equal(usageResponse.status, 200);
    assert.deepEqual(await usageResponse.json(), {
      claude: 0, codex: 0, opencode: 1, grok: 0, qoder: 0, pi: 0,
    });

    for (const provider of ["claude", "codex", "opencode", "qoder"]) {
      const historyResponse = await fetch(`${baseUrl}/api/${provider}-history`);
      assert.equal(historyResponse.status, 200);
      assert.deepEqual(await historyResponse.json(), []);
    }

    const firstPageResponse = await fetch(`${baseUrl}/api/session-list?offset=0&limit=1`);
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json() as { entries: Array<{ key: string }>; revision: string };
    assert.deepEqual(firstPage.entries.map((entry) => entry.key), [`session-${created.id}`]);
    assert.equal(typeof firstPage.revision, "string");

    const unchangedResponse = await fetch(
      `${baseUrl}/api/session-list?offset=0&limit=1&revision=${encodeURIComponent(firstPage.revision)}`,
    );
    assert.equal(unchangedResponse.status, 200);
    const unchanged = await unchangedResponse.json() as { unchanged?: boolean; entries: unknown[]; revision: string };
    assert.equal(unchanged.unchanged, true);
    assert.deepEqual(unchanged.entries, []);
    assert.equal(unchanged.revision, firstPage.revision);

    const directoriesResponse = await fetch(`${baseUrl}/api/session-directories`);
    assert.equal(directoriesResponse.status, 200);
    type DirectoryNode = {
      path: string;
      name: string;
      customName?: string;
      directCount: number;
      totalCount: number;
      entries: Array<{ key: string }>;
      children: DirectoryNode[];
    };
    const directories = await directoriesResponse.json() as {
      roots: DirectoryNode[];
      totalSessions: number;
      directoryCount: number;
      revision: string;
      treeRevision: string;
    };
    const findDirectory = (nodes: DirectoryNode[], target: string): DirectoryNode | undefined => {
      for (const node of nodes) {
        if (node.path === target) return node;
        const nested = findDirectory(node.children, target);
        if (nested) return nested;
      }
      return undefined;
    };
    const createdDirectory = findDirectory(directories.roots, root);
    assert.ok(directories.totalSessions >= 1);
    assert.ok(directories.directoryCount >= 1);
    assert.ok(createdDirectory);
    assert.ok(createdDirectory.directCount >= 1);
    assert.ok(createdDirectory.totalCount >= 1);
    assert.ok(createdDirectory.entries.some((entry) => entry.key === `session-${created.id}`));
    assert.equal(directories.revision, firstPage.revision);
    assert.equal(directories.treeRevision, directories.revision);

    const renameResponse = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: `${root}/`, name: "  演示工作区  " }),
    });
    assert.equal(renameResponse.status, 200);
    assert.deepEqual(await renameResponse.json(), { ok: true, path: root, name: "演示工作区" });

    const renamedDirectories = await (await fetch(`${baseUrl}/api/session-directories`)).json() as {
      roots: DirectoryNode[];
      revision: string;
      treeRevision: string;
    };
    const renamedDirectory = findDirectory(renamedDirectories.roots, root);
    assert.equal(renamedDirectory?.customName, "演示工作区");
    assert.equal(renamedDirectory?.name, createdDirectory.name);
    assert.equal(renamedDirectories.revision, directories.revision);
    assert.notEqual(renamedDirectories.treeRevision, directories.treeRevision);

    const tooLongName = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, name: "x".repeat(81) }),
    });
    assert.equal(tooLongName.status, 400);
    const multilineName = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, name: "两行\n名称" }),
    });
    assert.equal(multilineName.status, 400);
    const missingDirectory = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(root, "missing"), name: "Missing" }),
    });
    assert.equal(missingDirectory.status, 404);

    const resetNameResponse = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, name: null }),
    });
    assert.equal(resetNameResponse.status, 200);
    assert.deepEqual(await resetNameResponse.json(), { ok: true, path: root, name: null });
    const resetDirectories = await (await fetch(`${baseUrl}/api/session-directories`)).json() as {
      roots: DirectoryNode[];
      revision: string;
      treeRevision: string;
    };
    assert.equal(findDirectory(resetDirectories.roots, root)?.customName, undefined);
    assert.equal(resetDirectories.revision, directories.revision);
    assert.equal(resetDirectories.treeRevision, directories.treeRevision);

    const stalePageResponse = await fetch(
      `${baseUrl}/api/session-list?offset=1&limit=1&revision=${encodeURIComponent(firstPage.revision)}&cacheBust=1`,
    );
    assert.equal(stalePageResponse.status, 200);

    const secondCreatedResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "structured", cwd: root, provider: "opencode", mode: "assist" }),
    });
    assert.equal(secondCreatedResponse.status, 201);
    assert.equal((await (await fetch(`${baseUrl}/api/sessions/provider-usage`)).json()).opencode, 2);

    const changedPageResponse = await fetch(
      `${baseUrl}/api/session-list?offset=1&limit=1&revision=${encodeURIComponent(firstPage.revision)}&cacheBust=2`,
    );
    assert.equal(changedPageResponse.status, 409);

    messages.push({ role: "assistant", content: [
      { type: "tool_use", id: "mutation-read", name: "Read", input: { file_path: "/private/mutation.txt" } },
      { type: "tool_result", tool_use_id: "mutation-read", content: "PRIVATE_MUTATION_RESULT" },
    ] });
    for (const [endpoint, body] of [
      ["model", { model: "anthropic/claude-sonnet-4-6" }],
      ["thinking-effort", { thinkingEffort: "deep" }],
      ["mode", { mode: "managed" }],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/sessions/${created.id}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      const legacyMutation = await response.json() as { messages: Array<{ content: Array<Record<string, any>> }> };
      assert.equal(legacyMutation.messages[0].content[0].input.file_path, "/private/mutation.txt");
      assert.equal(legacyMutation.messages[0].content[1].content, "PRIVATE_MUTATION_RESULT");
      const compactResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Wand-Tool-Projection": "compact" },
        body: JSON.stringify(body),
      });
      assert.equal(compactResponse.status, 200);
      const compactMutation = await compactResponse.json() as typeof legacyMutation;
      assert.deepEqual(compactMutation.messages[0].content[0].input, {});
      assert.equal(compactMutation.messages[0].content[1].content, "");
      assert.doesNotMatch(JSON.stringify(compactMutation.messages), /\/private\/mutation\.txt/);
      assert.equal(compactMutation.messages[0].content[1].preview, "PRIVATE_MUTATION_RESULT");
    }
    messages.length = 0;

    const detailResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { selectedModel: string; thinkingEffort: string; mode: string };
    assert.equal(detail.selectedModel, "anthropic/claude-sonnet-4-6");
    assert.equal(detail.thinkingEffort, "deep");
    assert.equal(detail.mode, "managed");

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), { ok: true });
    assert.equal((await fetch(`${baseUrl}/api/sessions/${created.id}`)).status, 404);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/sessions/provider-usage`)).json(), {
      claude: 0, codex: 0, opencode: 1, grok: 0, qoder: 0, pi: 0,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    processes.dispose();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session list and detail DTOs keep workspace binding and queue skills", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-dto-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions });
  app.use(jsonErrorHandler);
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "structured",
        cwd: root,
        provider: "opencode",
        mode: "assist",
        workspaceId: "ws-dto",
        workspaceTaskId: "task-dto",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      id: string;
      workspaceId?: string;
      workspaceTaskId?: string;
    };
    assert.equal(created.workspaceId, "ws-dto");
    assert.equal(created.workspaceTaskId, "task-dto");

    const listed = await (await fetch(`${baseUrl}/api/sessions`)).json() as Array<{
      id: string;
      workspaceId?: string;
      workspaceTaskId?: string;
    }>;
    const item = listed.find((session) => session.id === created.id);
    assert.ok(item);
    assert.equal(item.workspaceId, "ws-dto");
    assert.equal(item.workspaceTaskId, "task-dto");

    const page = await (await fetch(`${baseUrl}/api/session-list?limit=10`)).json() as {
      entries: Array<{ session: { id: string; workspaceId?: string; workspaceTaskId?: string } }>;
    };
    const pageItem = page.entries.find((entry) => entry.session.id === created.id);
    assert.ok(pageItem);
    assert.equal(pageItem.session.workspaceId, "ws-dto");
    assert.equal(pageItem.session.workspaceTaskId, "task-dto");

    const detail = await (await fetch(`${baseUrl}/api/sessions/${created.id}`)).json() as {
      workspaceId?: string;
      workspaceTaskId?: string;
    };
    assert.equal(detail.workspaceId, "ws-dto");
    assert.equal(detail.workspaceTaskId, "task-dto");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    processes.dispose();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session created inside a sidebar task reaches the board card immediately", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-task-card-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions });
  app.use(jsonErrorHandler);
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const workspace = storage.createWorkspace({ name: "mk2api", cwd: root });
    const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "按渠道配置 API" });
    const card = storage.createWandTask({
      workspaceId: workspace.id,
      workspaceTaskId: task.id,
      title: task.name,
      status: "todo",
    });

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "structured",
        cwd: root,
        provider: "opencode",
        mode: "assist",
        workspaceId: workspace.id,
        workspaceTaskId: task.id,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string };

    // 侧栏「＋」刚建出来的会话必须在卡片上：不需要再拉一次 GET /api/wand-tasks。
    assert.deepEqual(storage.listWandTaskSessionIds(card.id), [created.id]);
    assert.equal(storage.getWandTask(card.id)?.status, "doing");
    assert.equal(storage.getWandTask(card.id)?.agent?.provider, "opencode");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    processes.dispose();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("首轮提示词不再把创建请求挂在 HTTP 上", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-respond-immediately-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const prompts: string[] = [];
  let resolveTurn: (() => void) | null = null;
  const live = {
    id: "structured-1",
    cwd: root,
    sessionKind: "structured",
    provider: "claude",
    output: "",
    messages: [],
  } as unknown as Record<string, unknown>;
  const structured = {
    createSession: () => live,
    get: () => live,
    sendMessage: (id: string, prompt: string) => {
      prompts.push(`${id}:${prompt}`);
      // 真实 runner 的首轮可能跑几分钟：这里用永不 resolve 的 promise 模拟。
      return new Promise((resolve) => { resolveTurn = () => resolve(live); });
    },
  } as unknown as StructuredSessionManager;
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const responded = await Promise.race([
      fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "structured", cwd: root, provider: "claude", prompt: "开始做这个任务" }),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    assert.ok(responded, "带了提示词的创建请求必须立刻返回，而不是等首轮跑完");
    assert.equal(responded.status, 201);
    assert.equal((await responded.json() as { id: string }).id, "structured-1");
    assert.deepEqual(prompts, ["structured-1:开始做这个任务"]);
    assert.ok(resolveTurn, "提示词必须在后台真的发出去");

    prompts.length = 0;
    const blocking = {
      id: "structured-2",
      cwd: root,
      sessionKind: "structured",
      provider: "claude",
      output: "",
      messages: [],
    } as unknown as Record<string, unknown>;
    structured.createSession = () => blocking;
    structured.get = () => blocking;
    structured.sendMessage = () => new Promise(() => {});
    const immediate = await Promise.race([
      fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "structured", cwd: root, provider: "claude", prompt: "继续" }),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    assert.ok(immediate, "structured 创建无论是否带旧 respondImmediately 字段都必须立即确认");
    assert.equal(immediate.status, 201);
    assert.equal((await immediate.json() as { id: string }).id, "structured-2");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    processes.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("创建会话时 systemPrompt 落到会话上，不并进首条消息", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-system-prompt-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "structured",
        cwd: root,
        provider: "opencode",
        mode: "assist",
        systemPrompt: "你是合并 Agent，只做本清单。",
      }),
    })).json() as { id: string };
    assert.equal(structured.get(created.id)?.systemPrompt, "你是合并 Agent，只做本清单。");
    assert.equal(storage.getSession(created.id)?.systemPrompt, "你是合并 Agent，只做本清单。");
    assert.deepEqual(structured.get(created.id)?.messages, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    processes.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("统一创建接口需要 kind，旧 POST 入口不再创建会话", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-unified-session-route-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    processes.dispose();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const body of [{}, { kind: "bad" }, { kind: null }]) {
    assert.equal((await fetch(`${baseUrl}/api/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).status, 400);
  }
  for (const body of [
    { kind: "structured", shell: true },
    { kind: "structured", command: "claude" },
    { kind: "structured", initialInput: "text" },
    { kind: "structured", prompt: 123 },
    { kind: "pty", command: "pi", initialInput: 123 },
  ]) {
    assert.equal((await fetch(`${baseUrl}/api/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).status, 400, "cross-kind fields must be rejected before creating a session");
  }
  assert.equal((await fetch(`${baseUrl}/api/structured-sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: root, provider: "opencode" }),
  })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/commands`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "pi", cwd: root }),
  })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/structured-sessions/legacy/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "hello" }),
  })).status, 404, "message route is mounted and reports the missing session");
  assert.equal((await fetch(`${baseUrl}/api/structured-sessions/legacy/queued`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: [] }),
  })).status, 400, "queue route is mounted and validates payload before manager lookup");
  assert.equal(sessions.listSlim().length, 0);
});

test("创建会话接口把 Pi 与 Wand Agent 当两个引擎，非法组合明确拒绝", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-engine-routes-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    processes.dispose();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "structured", cwd: root, mode: "default", ...body }),
  });

  const bogus = await post({ provider: "pi", engine: "bogus" });
  assert.equal(bogus.status, 400);
  assert.match(String((await bogus.json() as { error: string }).error), /执行引擎/);

  const wrongProvider = await post({ provider: "claude", engine: "sdk" });
  assert.equal(wrongProvider.status, 400);
  assert.match(String((await wrongProvider.json() as { error: string }).error), /Wand Agent/);
  const ptySdk = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "pty", command: "pi", engine: "sdk", cwd: root }),
  });
  assert.equal(ptySdk.status, 400);
  const ptyCli = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "pty", command: "pi", engine: "cli", cwd: root }),
  });
  assert.equal(ptyCli.status, 201, "PTY permits the explicit CLI engine");

  // Pi CLI：不传引擎与显式 cli 等价，pi-settings 必须报告 cli。
  const cli = await post({ provider: "pi" });
  assert.equal(cli.status, 201);
  const cliSession = await cli.json() as { id: string };
  const settings = await (await fetch(`${baseUrl}/api/sessions/${cliSession.id}/pi-settings`)).json() as { engine: string };
  assert.equal(settings.engine, "cli");

  // Wand Agent now probes lazily on explicit selection. A file, not a directory,
  // is a deterministic unavailable auth source regardless of developer env/auth.
  config.harness = { ...config.harness!, agentDir: path.join(root, "wand.db") };
  const sdk = await post({ provider: "pi", engine: "sdk" });
  assert.equal(sdk.status, 400);
  assert.match(String((await sdk.json() as { error: string }).error), /core|harness/i);
  const listed = await (await fetch(`${baseUrl}/api/sessions`)).json() as Array<{ id: string }>;
  assert.deepEqual(listed.map((item) => item.id).sort(), [cliSession.id, (await ptyCli.json() as { id: string }).id].sort(),
    "only successful CLI/PTY creations remain after rejecting SDK");
});
