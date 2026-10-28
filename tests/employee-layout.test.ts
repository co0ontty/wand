import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmployeeCreateForm } from "../src/web-ui/react/agents/employee-create-form.js";
import { EmployeeAvatarWorkspace } from "../src/web-ui/react/agents/employee-avatar-workspace.js";

const source = (path: string) => readFileSync(new URL(`../src/web-ui/react/${path}`, import.meta.url), "utf8");

test("employee layout is bounded by its real container rather than a phone-sized form", () => {
  const styles = source("styles/employee-profile.ts");
  const teamStyles = source("ai-teams/styles.ts");
  assert.match(styles, /container:employeeeditor \/ inline-size/);
  assert.match(styles, /@container employeeeditor \(min-width:1040px\)/);
  assert.match(styles, /@container employeedirectory \(min-width:1440px\)/);
  assert.doesNotMatch(styles, /max-width:(800|920)px/);
  assert.match(teamStyles, /\.wand-employees-layout>\.wand-employee-list \{ width:100%; max-width:none;/);
});

test("employee drawer passes its finite height through the editor to the body scroll owner", () => {
  const styles = source("styles/employee-profile.ts");
  assert.match(styles, /\.wand-object-profile-drawer:has\(\[data-employee-profile\]\) \.ant-drawer-body\{display:flex;flex-direction:column;min-height:0;[^}]*overflow:hidden/,
    "overflow-hidden Drawer body must be a flex parent so the editor can shrink within the viewport");
  assert.match(styles, /\.employee-profile-content,\[data-employee-profile\]\{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;/);
  assert.match(styles, /\[data-employee-profile\]\.wand-team-member\{[^}]*overflow:hidden/);
  assert.match(styles, /\[data-employee-profile\] \.profile-body\{overflow:auto;min-height:0;flex:1;/,
    "the inner body owns scrolling while the editor header remains reachable");
});

test("new employee fields remain in the same progressive single-page form", () => {
  const html = renderToStaticMarkup(React.createElement(EmployeeCreateForm, {
    catalog: null, providerOptions: [], onSave: async () => {}, onCancel: () => {},
  }));
  assert.match(html, /new-employee-expectation/);
  assert.match(html, /人选资料（可手动填写）/);
  assert.match(html, /嘟嘟 · 招聘 HR/);
  assert.match(html, /岗位需求/);
  assert.match(html, /请嘟嘟拟定人选/);
  assert.match(html, /wand-settings-library-action-label/);
  assert.doesNotMatch(html, /role="tab"|employee-directory/);
});

test("avatar preview and controls have one shared responsive workspace with native radios", () => {
  const html = renderToStaticMarkup(React.createElement(EmployeeAvatarWorkspace, {
    employee: { id: "layout-fixture", name: "预览员工", avatar: "plush:v1:heart:coral:none:none" },
    disabled: false, onChange: () => {},
  }));
  assert.match(html, /appearance-layout/);
  assert.match(html, /appearance-controls/);
  assert.match(html, /type="radio"/);
  const fixed = renderToStaticMarkup(React.createElement(EmployeeAvatarWorkspace, {
    employee: { id: "e_wand_default", name: "固定员工", systemKey: "wand-default" },
    disabled: false, onChange: () => {},
  }));
  assert.match(fixed, /系统固定头像/);
  assert.doesNotMatch(fixed, /type="radio"|type="file"/);
});

test("cancelling employee creation releases the parent busy projection", () => {
  assert.match(source("agents/employee-list-page.tsx"), /onCancel=\{\(\) => \{ setIsCreating\(false\); setDirty\(false\); setBusy\(false\); \}\}/);
  const create = source("agents/employee-create-form.tsx");
  const edit = source("agents/employee-card.tsx");
  assert.match(create, /<SettingsActionButton[\s\S]*?pending=\{saving \|\| filling\}/);
  assert.match(create, /onClick=\{\(\) => handleFillFromExpectation\(\)\}/);
  assert.match(edit, /<SettingsActionButton className="wand-employee-save-submit"/);
});
