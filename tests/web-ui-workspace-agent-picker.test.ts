import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { nextChoice } from "../src/web-ui/react/new-session/choice-navigation.js";
import type { WorkspaceAgentPickerProps } from "../src/web-ui/react/workspaces/workspace-agent-picker.js";

const source = readFileSync(
  new URL("../src/web-ui/react/workspaces/workspace-agent-picker.tsx", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
});

type Radio = React.ReactElement<{
  role: string;
  tabIndex: number;
  "aria-checked": boolean;
  ref(element: { focus(): void }): void;
  onClick(): void;
  onKeyDown(event: { key: string; preventDefault(): void }): void;
}>;

function harness(overrides: Partial<WorkspaceAgentPickerProps> = {}) {
  const preferences: unknown[] = [];
  const changes: string[] = [];
  let focused = "";
  const props: WorkspaceAgentPickerProps = {
    target: "claude",
    kind: "structured",
    onTargetChange: (target) => { props.target = target; changes.push(target); },
    onKindChange: (kind) => { props.kind = kind; changes.push(kind); },
    ...overrides,
  };
  const dependencies: Record<string, unknown> = {
    react: { ...React, useRef: (current: unknown) => ({ current }) },
    "react/jsx-runtime": jsxRuntime,
    "../new-session/choice-navigation": { nextChoice },
    "../new-session/repository": {
      httpNewSessionRepository: {
        savePreferences: (value: unknown) => {
          preferences.push(JSON.parse(JSON.stringify(value)));
          return Promise.resolve();
        },
      },
    },
    "../provider-logo": { ProviderLogo: () => null },
    "../ui": { WandButton: () => null, WandIcon: () => null },
  };
  const exports: Record<string, (props: WorkspaceAgentPickerProps) => React.ReactNode> = {};
  runInNewContext(outputText, {
    exports,
    require: (id: string) => {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    },
    window: { requestAnimationFrame: (callback: () => void) => callback() },
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
          radio.props.ref({ focus: () => { focused = key; } });
        }
        visit(child.props.children);
      });
    }
    visit(exports.WorkspaceAgentPicker(props));
    return result;
  }

  function key(current: string, value: string): boolean {
    let prevented = false;
    radios().get(current)!.props.onKeyDown({
      key: value,
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  }

  return { props, preferences, changes, radios, key, focused: () => focused };
}

test("session kind uses one tab stop and moves selection, focus and preference together", () => {
  const h = harness();
  assert.equal(h.radios().get("structured")!.props.tabIndex, 0);
  assert.equal(h.radios().get("pty")!.props.tabIndex, -1);
  for (const [key, expected] of [
    ["ArrowRight", "pty"], ["ArrowDown", "structured"],
    ["ArrowLeft", "pty"], ["ArrowUp", "structured"],
    ["End", "pty"], ["Home", "structured"],
  ] as const) {
    assert.equal(h.key(h.props.kind, key), true);
    assert.equal(h.props.kind, expected);
    assert.equal(h.focused(), expected);
    assert.deepEqual(h.preferences.at(-1), { defaultSessionKind: expected });
    const radios = h.radios();
    assert.equal(radios.get(expected)!.props.tabIndex, 0);
    assert.equal(radios.get(expected)!.props["aria-checked"], true);
    assert.equal(radios.get(expected === "pty" ? "structured" : "pty")!.props.tabIndex, -1);
  }
  h.radios().get("pty")!.props.onClick();
  assert.equal(h.props.kind, "pty");
  assert.deepEqual(h.preferences.at(-1), { defaultSessionKind: "pty" });
});

test("provider keyboard and click choices save the same preferences, excluding shell", () => {
  const h = harness();
  assert.equal(h.key("claude", "ArrowRight"), true);
  assert.equal(h.props.target, "codex");
  assert.equal(h.focused(), "codex");
  assert.deepEqual(h.preferences.at(-1), { defaultProvider: "codex" });
  h.radios().get("pi")!.props.onClick();
  assert.equal(h.props.target, "pi");
  assert.deepEqual(h.preferences.at(-1), { defaultProvider: "pi" });
  assert.equal(h.key("pi", "End"), true);
  assert.equal(h.props.target, "shell");
  assert.equal(h.focused(), "shell");
  assert.equal(h.preferences.length, 2);
  assert.equal(h.radios().has("structured"), false);
  assert.equal(h.key("shell", "Home"), true);
  assert.equal(h.props.target, "claude");
  assert.deepEqual(h.preferences.at(-1), { defaultProvider: "claude" });
});

test("local and disabled pickers retain their preference and keyboard contracts", () => {
  const local = harness({ persistPreferences: false });
  local.key("claude", "ArrowDown");
  local.key("structured", "ArrowRight");
  local.radios().get("pi")!.props.onClick();
  local.radios().get("structured")!.props.onClick();
  assert.deepEqual(local.changes, ["codex", "pty", "pi", "structured"]);
  assert.deepEqual(local.preferences, []);
  assert.equal(local.key("pi", "Tab"), false);

  const disabled = harness({ disabled: true });
  assert.equal(disabled.key("claude", "ArrowRight"), false);
  assert.equal(disabled.key("structured", "End"), false);
  disabled.radios().get("pi")!.props.onClick();
  disabled.radios().get("pty")!.props.onClick();
  assert.deepEqual(disabled.changes, []);
  assert.deepEqual(disabled.preferences, []);
  assert.equal(disabled.focused(), "");
});
