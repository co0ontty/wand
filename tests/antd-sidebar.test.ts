import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImSidebarGroup } from "../src/web-ui/react/shell/im-sidebar-group.js";
import { ImSidebarItem } from "../src/web-ui/react/shell/im-sidebar-item.js";
import { UnifiedExecutionSubjectPicker } from "../src/web-ui/react/workspaces/unified-execution-subject-picker.js";
import { SidebarRecentSection } from "../src/web-ui/react/workspaces/sidebar-recent-section.js";
import { getShellSidebarEntryActions } from "../src/web-ui/react/shell/shell-sidebar.js";

// These assertions check the library's real rendering and business identities;
// browser tests exercise the focus, selection and close behavior.
test("sidebar disclosures use controlled Ant Collapse without a second native disclosure", () => {
  for (const expanded of [true, false]) {
    const html = renderToStaticMarkup(createElement(ImSidebarGroup, {
      label: "真实员工", count: 1, expanded,
      children: createElement(ImSidebarItem, { id: "session:42", title: "真实会话", summary: "项目目录",
        active: true, state: { label: "失败", tone: "danger", icon: "info", spinning: false }, onClick() {} }),
    }));
    assert.match(html, /ant-collapse/);
    assert.match(html, new RegExp(`data-open="${expanded}"`));
    assert.match(html, new RegExp(`aria-expanded="${expanded}"`));
    if (expanded) {
      assert.match(html, /data-session-id="session:42"/);
      assert.match(html, /aria-current="page"/);
      assert.match(html, /wand-ui-button-soft/);
    } else {
      assert.match(html, /inert=""/);
      assert.match(html, /aria-hidden="true"/);
      assert.doesNotMatch(html, /data-session-id="session:42"/, "destroyOnHidden does not mount collapsed rows during SSR");
    }
    assert.doesNotMatch(html, /<(?:details|summary)\b/);
  }
});

test("execution choices use real library radio identities and disable teams without a project", () => {
  const html = renderToStaticMarkup(createElement(UnifiedExecutionSubjectPicker, {
    selectedSubject: { type: "cli", id: "codex" }, kind: "structured", model: "default",
    teams: [{ id: "team:real", name: "真实团队", detail: "保留团队身份" }],
    onSubjectChange() {}, onKindChange() {}, onModelChange() {},
  }));
  assert.match(html, /ant-segmented/);
  assert.match(html, /ant-radio-group/);
  assert.match(html, /value="cli:codex"/);
  assert.match(html, /value="team:team:real"/);
  assert.match(html, /disabled=""[^>]*value="team:team:real"|value="team:team:real"[^>]*disabled=""/);
  assert.doesNotMatch(html, /<button[^>]*role="radio"/);
});

test("recent loading uses Ant Skeleton and its new-work entry defers contact choice to the shared page", () => {
  const html = renderToStaticMarkup(createElement(SidebarRecentSection, {
    entries: [], employees: [], displayMode: "full", selectedSessionId: null, now: 0,
    listLoading: true, contactsError: "加载失败", onOpen() {},
  }));
  assert.match(html, /aria-label="正在加载最近对话"/);
  assert.match(html, /ant-skeleton/);
  assert.match(html, /aria-label="新建工作"/);
  assert.doesNotMatch(html, /sidebar-contact-picker/);
});

test("history actions preserve actual provider resume identities and manage selection", () => {
  const entry = { id: "native:42", source: "codex-history", cwd: "/real", provider: "codex" } as any;
  assert.deepEqual(getShellSidebarEntryActions(entry, false).primary,
    { type: "session.resumeHistory", provider: "codex", id: "native:42", cwd: "/real" });
  assert.deepEqual(getShellSidebarEntryActions(entry, true).primary,
    { type: "session.manage.select", target: "codex-history", id: "native:42" });
});
