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
    useMemo: (fn: () => unknown) => fn(),
    useRef: (initial: unknown) => ({ current: initial }),
  };
  const dependencies: Record<string, unknown> = {
    react,
    "react/jsx-runtime": jsxRuntime,
    "../agents/employee-avatar.js": { EmployeeAvatar: () => null },
    "../ui": { WandIcon: () => null, WandSelect: () => null },
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

  function radios(): Map<string, Radio> {
    const result = new Map<string, Radio>();
    function visit(node: React.ReactNode): void {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement<{ role?: string; children?: React.ReactNode }>(child)) return;
        if (child.props.role === "radio") {
          const radio = child as Radio;
          const key = String(child.key);
          result.set(key, radio);
          radio.props.ref?.({ focus: () => { focused = key; } });
        }
        visit(child.props.children);
      });
    }
    visit(exports.UnifiedExecutionSubjectPicker(props));
    return result;
  }

  function key(current: string, value: string): boolean {
    let prevented = false;
    radios().get(current)!.props.onKeyDown({ key: value, preventDefault: () => { prevented = true; } });
    return prevented;
  }
  return { props, changes, radios, key, focused: () => focused };
}

test("structured subjects offer active employees, teams and CLI with keyboard navigation", () => {
  const h = harness();
  const radios = h.radios();
  assert.ok(radios.has("e1"));
  assert.equal(radios.has("e2"), false, "archived employees are not assignable");
  assert.ok(radios.has("t1"));
  assert.ok(radios.has("claude"));
  assert.equal(h.key("claude", "Home"), true);
  assert.equal(h.changes.at(-1), "employee:e1");
  assert.equal(h.focused(), "e1");
  assert.equal(h.key("e1", "ArrowRight"), true);
  assert.equal(h.changes.at(-1), "team:t1");
  assert.equal(h.focused(), "t1");
});

test("PTY switches employee back to CLI and hides employee and team choices", () => {
  const h = harness({ selectedSubject: { type: "employee", id: "e1" } });
  h.radios().get("pty")!.props.onClick();
  assert.deepEqual(h.changes, ["pty", "cli:claude"]);
  assert.equal(h.props.kind, "pty");
  const radios = h.radios();
  assert.equal(radios.has("e1"), false);
  assert.equal(radios.has("t1"), false);
  assert.ok(radios.has("claude"));
  assert.equal(h.key("structured", "End"), true);
  assert.equal(h.props.kind, "pty");
});

test("disabled and project-blocked choices cannot enter the keyboard sequence", () => {
  const blocked = harness({ teamWorkspaceId: "" });
  assert.equal(blocked.radios().get("t1")!.props.disabled, true);
  assert.equal(blocked.key("e1", "ArrowRight"), true);
  assert.match(blocked.changes.at(-1) ?? "", /^cli:(claude|codex|shell)$/);
  const disabled = harness({ disabled: true });
  assert.equal(disabled.key("claude", "ArrowRight"), false);
  assert.equal(disabled.radios().get("claude")!.props.disabled, true);
  assert.deepEqual(disabled.changes, []);
});
