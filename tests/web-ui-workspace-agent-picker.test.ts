import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { nextChoice } from "../src/web-ui/react/new-session/choice-navigation.js";
import { sortProviderOptions } from "../src/web-ui/react/provider-usage.js";
import type { UnifiedExecutionSubjectPickerProps } from "../src/web-ui/react/workspaces/unified-execution-subject-picker.js";

const source = readFileSync(new URL("../src/web-ui/react/workspaces/unified-execution-subject-picker.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
});

type Radio = React.ReactElement<{
  role: string;
  disabled?: boolean;
  tabIndex: number;
  "aria-checked": boolean;
  ref?(node: { focus(): void }): void;
  onClick(): void;
  onKeyDown(event: { key: string; preventDefault(): void }): void;
}>;

const cliOptions = [
  { value: "claude", label: "Claude", description: "Claude Code" },
  { value: "codex", label: "Codex", description: "Codex CLI" },
  { value: "shell", label: "空白终端", description: "Shell" },
];
const employees = [
  { id: "e1", name: "设计师", duty: "界面设计", agents: [{ provider: "claude" }] },
  { id: "e2", name: "归档员工", duty: "", archivedAt: "2026-01-01", agents: [] },
];

function harness(overrides: Partial<UnifiedExecutionSubjectPickerProps> = {}) {
  const changes: string[] = [];
  let focused = "";
  const props: UnifiedExecutionSubjectPickerProps = {
    selectedSubject: { type: "cli", id: "claude" },
    kind: "structured",
    model: "default",
    teams: [{ id: "t1", name: "研发团队", detail: "2 人" }],
    teamWorkspaceId: "ws1",
    onSubjectChange: (subject) => { props.selectedSubject = subject; changes.push(`${subject.type}:${subject.id}`); },
    onKindChange: (kind) => { props.kind = kind; changes.push(kind); },
    onModelChange: (model) => { props.model = model; changes.push(model); },
    ...overrides,
  };
  const react = {
    ...React,
    useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useRef: (initial: unknown) => ({ current: initial }),
  };
  const dependencies: Record<string, unknown> = {
    antd: { Radio: Object.assign(() => null, { Group: () => null }), Segmented: () => null, Alert: () => null, Spin: () => null, Flex: () => null, Form: { Item: () => null }, Typography: { Text: () => null, Paragraph: () => null } },
    "../theme": { WandUiBoundary: () => null },
    "../shell/sidebar-styles": { installSidebarStyles: () => {} },
    react,
    "react/jsx-runtime": jsxRuntime,
    "../agents/employee-avatar.js": { EmployeeAvatar: () => null },
    "../ui": { WandIcon: () => null, WandSelect: () => null, WandButton: () => null },
    "../provider-logo.js": { ProviderLogo: () => null },
    "../provider-usage.js": { sortProviderOptions, useProviderUsage: () => ({}) },
    "../new-session/choice-navigation.js": { nextChoice },
    "./workspace-agent-picker.js": {
      WORKSPACE_AGENT_OPTIONS: cliOptions,
      WORKSPACE_KIND_OPTIONS: [
        { value: "structured", label: "结构化", description: "聊天" },
        { value: "pty", label: "PTY", description: "终端" },
      ],
      TEAM_NEEDS_PROJECT_HINT: "先选项目",
    },
    "../agents/employee-repository.js": { useSiliconEmployees: () => ({ employees, loading: false }) },
    "../use-model-catalog.js": { useWandModelCatalog: () => null },
    "../model-catalog.js": { MODEL_CATALOG_DEFAULT_VALUE: "default", wandModelOptions: () => [] },
    "../issues/task-board-controller.js": { taskBoardController: { open: () => {} } },
  };
  const exports: Record<string, (props: UnifiedExecutionSubjectPickerProps) => React.ReactNode> = {};
  runInNewContext(outputText, {
    exports,
    require: (id: string) => {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    },
    requestAnimationFrame: (callback: () => void) => callback(),
  });

  const ant = dependencies.antd as any;
  function projection() {
    const radios = new Map<string, React.ReactElement<any>>();
    let subject: React.ReactElement<any> | undefined;
    let kind: React.ReactElement<any> | undefined;
    function visit(node: React.ReactNode): void {
      React.Children.forEach(node, child => {
        if (!React.isValidElement<any>(child)) return;
        if (child.type === ant.Radio) radios.set(String(child.key), child);
        if (child.type === ant.Radio.Group) subject = child;
        if (child.type === ant.Segmented) kind = child;
        visit(child.props.children);
      });
    }
    visit(exports.UnifiedExecutionSubjectPicker(props));
    return { radios, subject: subject!, kind: kind! };
  }
  function choose(id: string) {
    const current = projection();
    const choice = current.radios.get(id)!;
    if (current.subject.props.disabled || choice.props.disabled) return;
    current.subject.props.onChange({ target: { value: choice.props.value } });
  }
  return { props, changes, projection, choose };
}

test("structured subjects use the library radio group with real employee/team/CLI identities", () => {
  const h = harness();
  const { radios, subject, kind } = h.projection();
  assert.ok(radios.has("e1"));
  assert.equal(radios.has("e2"), false, "archived employees are not assignable");
  assert.ok(radios.has("t1")); assert.ok(radios.has("claude"));
  assert.equal(subject.props["aria-label"], "执行主体");
  assert.equal(subject.props.value, "cli:claude");
  assert.equal(kind.props["aria-label"], "会话类型");
  h.choose("e1"); h.choose("t1");
  assert.deepEqual(h.changes, ["employee:e1", "team:t1"]);
  // Ant owns roving radio/Segmented keyboard navigation; the production sidebar Chrome gate verifies it.
});

test("PTY switches employee back to CLI and hides employee and team choices", () => {
  const h = harness({ selectedSubject: { type: "employee", id: "e1" } });
  h.projection().kind.props.onChange("pty");
  assert.deepEqual(h.changes, ["pty", "cli:claude"]);
  const { radios, kind } = h.projection();
  assert.equal(kind.props.value, "pty");
  assert.equal(radios.has("e1"), false); assert.equal(radios.has("t1"), false);
  assert.ok(radios.has("claude"));
});

test("disabled and project-blocked choices cannot change the selected execution identity", () => {
  const blocked = harness({ teamWorkspaceId: "" });
  assert.equal(blocked.projection().radios.get("t1")!.props.disabled, true);
  blocked.choose("t1"); assert.deepEqual(blocked.changes, []);
  const disabled = harness({ disabled: true });
  assert.equal(disabled.projection().subject.props.disabled, true);
  assert.equal(disabled.projection().kind.props.disabled, true);
  disabled.choose("claude"); disabled.projection().kind.props.onChange("pty");
  assert.deepEqual(disabled.changes, []);
});
