import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeTeamChatDetail, TeamChatView } from "../src/web-ui/react/ai-teams/team-chat-view.js";
import { deliverySummaryText, deliveryText, TeamDeliveryDetails } from "../src/web-ui/react/ai-teams/team-delivery.js";
import { TeamRunView } from "../src/web-ui/react/issues/team-run-panel.js";
import { teamDeliveryFixture } from "./helpers/team-delivery-fixture.js";
import { configureTeamChatComposerRuntime } from "../src/web-ui/react/ai-teams/composer-bridge.js";

configureTeamChatComposerRuntime({
  read: () => ({ text: "", attachments: [], revision: 0 }),
  edit: () => false,
  subscribe: () => () => {},
  submit: (_id, text, deliver) => deliver({ text, attachments: [] }),
});

test("delivery details use bounded server previews, old files keep identity, all totals show truncation", () => {
  const delivery = teamDeliveryFixture().delivery!;
  const html = renderToStaticMarkup(React.createElement(TeamDeliveryDetails, { delivery }));
  for (const text of ["真实冻结摘要", "仅显示服务器提供的摘录", "report-1.md", "2/23", "21 个未列出", "1/8", "7 项未列出", "等待：实现步骤"]) {
    assert.ok(html.includes(text), text);
  }
  assert.equal(html.includes("/api/file-"), false, "no preview/raw URL or prefetch in rendered details");
  assert.equal(html.includes("已验收"), false);
  assert.equal(deliveryText("字".repeat(1000)).length, 161);
  assert.ok(deliverySummaryText(delivery).includes("23 个文件"));
  const noFiles = renderToStaticMarkup(React.createElement(TeamDeliveryDetails, {
    delivery: { ...delivery, files: [], totalFiles: 0 },
  }));
  assert.ok(noFiles.includes("无可确认文件"));
  const oversized = { ...delivery,
    files: Array.from({ length: 25 }, (_, index) => ({ ...delivery.files[0]!, stepId: `file-${index}` })),
    handoffs: Array.from({ length: 8 }, (_, index) => ({ ...delivery.handoffs[0]!, stepId: `handoff-${index}` })),
    totalFiles: 25, totalHandoffs: 8,
  };
  const bounded = renderToStaticMarkup(React.createElement(TeamDeliveryDetails, { delivery: oversized }));
  assert.equal((bounded.match(/class="[^"]*ant-file-card [^"]*"/g) ?? []).length, 20);
  assert.equal((bounded.match(/class="[^"]*\bteam-delivery-handoff\b[^"]*"/g) ?? []).length, 6);
});

test("merge preserves fresh delivery against stale run, old timestamp, absent field and late partial same snapshot", () => {
  const fresh = teamDeliveryFixture();
  fresh.run.status = "done";
  fresh.run.updatedAt = "2026-10-03T10:02:00Z";
  fresh.delivery!.updatedAt = fresh.run.updatedAt;
  fresh.delivery!.conclusion = "负责人报告了交付，不是服务端验证";
  const old = teamDeliveryFixture();
  assert.equal(mergeTeamChatDetail(fresh, old).delivery, fresh.delivery);
  const missing = { ...fresh, delivery: undefined };
  assert.equal(mergeTeamChatDetail(fresh, missing).delivery, fresh.delivery);
  const partial = { ...fresh, delivery: { ...fresh.delivery!, files: [], handoffs: [] } };
  assert.equal(mergeTeamChatDetail(fresh, partial).delivery, fresh.delivery);
  const oldRun = teamDeliveryFixture("task-a", "run-previous");
  oldRun.run.createdAt = "2026-10-02T10:00:00Z";
  assert.equal(mergeTeamChatDetail(fresh, oldRun), fresh);
  const newRun = teamDeliveryFixture("task-a", "run-next");
  newRun.run.createdAt = "2026-10-04T10:00:00Z";
  assert.equal(mergeTeamChatDetail(fresh, newRun), newRun);
});

test("same-revision full 20-file windows retain the snapshot when totals or existing identities regress", () => {
  const current = teamDeliveryFixture();
  const template = current.delivery!.files[1]!;
  const windowFiles = (newest: number) => Array.from({ length: 20 }, (_, index) => {
    const seq = newest - index;
    return { ...template, stepId: `step-${seq}`, seq,
      file: { ...template.file, stepId: `step-${seq}`, path: `/synthetic/report-${seq}.md`, name: `report-${seq}.md` } };
  });
  current.delivery!.files = windowFiles(25);
  current.delivery!.totalFiles = 25;
  for (const [totalFiles, files] of [
    [24, windowFiles(24)], // Reviewer reproduction: 25→6 becomes 24→5; both lengths are 20.
    [24, windowFiles(25)], // Isolate a decreased total even with every existing identity present.
    [25, windowFiles(24)], // Isolate a missing identity even when the total has not decreased.
    [25, windowFiles(25).map((file, index) => index ? file : {
      ...file, file: { ...file.file, path: "/synthetic/replaced-path.md" },
    })], // Matching stepId alone cannot confirm the same frozen file.
  ] as const) {
    const older = { ...structuredClone(current),
      delivery: { ...current.delivery!, totalFiles, files } };
    assert.deepEqual(older.run, current.run);
    assert.deepEqual(older.steps, current.steps);
    assert.equal(older.delivery.files.length, 20);
    const merged = mergeTeamChatDetail(current, older);
    assert.equal(merged.delivery, current.delivery, "retain the complete snapshot, do not union files");
    assert.equal(merged.delivery!.files.length, 20);
    assert.equal(merged.delivery!.files[0]!.seq, 25);
    assert.equal(merged.delivery!.files.at(-1)!.seq, 6);
  }
  const enriched = structuredClone(current);
  enriched.delivery!.files.at(-1)!.file.preview = { title: "迟到的冻结标题", excerpt: "完整摘录" };
  assert.equal(mergeTeamChatDetail(current, enriched).delivery, enriched.delivery,
    "same-revision preview enrichment with the complete existing window remains accepted");
});

test("newer source revision without delivery removes old approval or conclusion and falls back to original UI", () => {
  for (const status of ["awaiting_approval", "done"] as const) {
    const current = teamDeliveryFixture();
    current.run.status = status;
    current.delivery!.attention = status === "awaiting_approval"
      ? { kind: "approval", message: "旧批准说明" } : null;
    current.delivery!.conclusion = status === "done" ? "旧负责人交付说明" : null;
    const newer = structuredClone(current);
    newer.run.updatedAt = "2026-10-03T10:01:00.000Z";
    newer.run.status = "running";
    newer.run.statusDetail = "新版原始状态说明";
    delete newer.delivery;
    const merged = mergeTeamChatDetail(current, newer);
    assert.equal(merged.run, newer.run);
    assert.equal(merged.delivery, undefined, "a newer field-less source must not retain obsolete delivery");
    const chat = renderToStaticMarkup(React.createElement(TeamChatView, { detail: merged, onChange() {} }));
    assert.ok(chat.includes("群公告"));
    assert.equal(chat.includes("旧批准说明"), false);
    assert.equal(chat.includes("旧负责人交付说明"), false);
    const panel = renderToStaticMarkup(React.createElement(TeamRunView, { detail: merged, onChange() {} }));
    assert.ok(panel.includes("新版原始状态说明"));
    assert.equal(panel.includes('aria-label="退回意见"'), false);
    assert.equal(panel.includes("旧负责人交付说明"), false);
    const sameRevision = { ...current, delivery: undefined };
    assert.equal(mergeTeamChatDetail(current, sameRevision).delivery, current.delivery);
    const olderRevision = { ...newer, run: { ...newer.run, updatedAt: "2026-10-03T09:59:00.000Z" } };
    assert.equal(mergeTeamChatDetail(current, olderRevision).delivery, current.delivery);
  }
});

test("same run timestamp and steps retain frozen preview against missing, empty or partial old DTO", () => {
  const current = teamDeliveryFixture();
  const delivery = current.delivery!;
  for (const preview of [undefined, { title: "", excerpt: "" },
    { title: delivery.files[0]!.file.preview!.title, excerpt: "   " },
    { title: "   ", excerpt: delivery.files[0]!.file.preview!.excerpt }]) {
    const older = structuredClone(current);
    older.delivery!.files[0]!.file.preview = preview;
    assert.deepEqual(older.run, current.run, "updatedAt and all run facts are identical");
    assert.deepEqual(older.steps, current.steps, "step progress is identical");
    assert.equal(mergeTeamChatDetail(current, older).delivery, delivery,
      "missing or emptied frozen preview must not erase complete delivery");
  }
  const lateComplete = teamDeliveryFixture();
  lateComplete.delivery!.files[1]!.file.preview = { title: "晚到的真实冻结标题", excerpt: "完整摘录" };
  assert.equal(mergeTeamChatDetail(current, lateComplete).delivery, lateComplete.delivery,
    "a complete preview may arrive without advancing the run timestamp");
});

test("no delivery preserves old chat context and status detail; new delivery does not duplicate full status text", () => {
  const old = { ...teamDeliveryFixture(), delivery: undefined };
  const oldChat = renderToStaticMarkup(React.createElement(TeamChatView, { detail: old, onChange() {} }));
  assert.ok(oldChat.includes("群公告"));
  const oldPanel = renderToStaticMarkup(React.createElement(TeamRunView, { detail: old, onChange() {} }));
  assert.ok(oldPanel.includes(old.run.statusDetail));
  const nextPanel = renderToStaticMarkup(React.createElement(TeamRunView, { detail: teamDeliveryFixture(), onChange() {} }));
  assert.equal(nextPanel.includes(old.run.statusDetail), false);
  assert.equal((nextPanel.match(/aria-label="回复负责人"/g) ?? []).length, 1, "only original reply control instance");
});

test("delivery is chunk-owned and disclosure/request guards keep canonical DOM and motion seams", () => {
  const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const component = read("src/web-ui/react/ai-teams/team-delivery.tsx");
  assert.match(component, /filePreviewController\.open\(item\.file\.path\)/);
  assert.doesNotMatch(component, /fetch\(|querySelector|getElementById|reportPath|chatTurns/);
  assert.match(component, /choice\.runId === delivery\.runId/);
  const panel = read("src/web-ui/react/issues/team-run-panel.tsx");
  assert.match(panel, /generation === requestGeneration\.current/);
  assert.match(panel, /key=\{props\.taskId\}/);
  assert.match(panel, /next\.run\.id !== latestId/);
  assert.match(read("scripts/ai-teams-chunk.js"), /"ai-teams", "team-delivery\.tsx"/);
  assert.doesNotMatch(read("src/web-ui/react/ai-teams/lazy.tsx"), /import.*team-delivery/);
  assert.match(component, /<Collapse ghost bordered=\{false\} activeKey=\{open \? \["delivery"\] : \[\]\}/);
  assert.match(component, /forceRender: true/);
  assert.match(component, /inert=\{!open\}/);
  assert.match(component, /event\.key === "Escape" && open/);
  assert.match(component, /trigger\.current\?\.focus\(\)/);
  assert.doesNotMatch(read("src/web-ui/react/ai-teams/styles.ts"), /\.team-delivery-(?:body|trigger|inner)\s*\{/);
});
