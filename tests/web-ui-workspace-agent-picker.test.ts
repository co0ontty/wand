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

type ModelSelectProps = {
  value?: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onValueChange?(value: string): void;
};

/** 模型目录在 vm 里用桩代替：只验证选择器与「跟随服务端默认」哨兵值的契约。 */
const MODEL_CATALOG_DEPENDENCY = {
  MODEL_CATALOG_DEFAULT_VALUE: "default",
  pickedModelId: (model: string | null | undefined) => {
    const value = (model ?? "").trim();
    return value === "default" ? "" : value;
  },
  wandModelOptions: (catalog: { byProvider?: Record<string, unknown> } | null, provider: string) =>
    catalog?.byProvider?.[provider] ?? [{ value: "default", label: "跟随服务端默认" }],
};

/** 没被渲染的 stub：靠自身标记被遍历找到，元素的 props 就是选择器收到的 props。 */
function WandSelectStub(_props: ModelSelectProps): null {
  return null;
}
const WAND_SELECT_MARK = "wandSelectStub";
(WandSelectStub as unknown as Record<string, unknown>)[WAND_SELECT_MARK] = true;

function harness(overrides: Partial<WorkspaceAgentPickerProps> = {}) {
  const preferences: unknown[] = [];
  const changes: string[] = [];
  const remembered: Array<{ provider: string; model: string }> = [];
  let focused = "";
  let runtime: {
    modelPreference?(provider: string): string;
    rememberModelPreference?(provider: string, model: string): void;
  } | null = {
    modelPreference: () => "opus",
    rememberModelPreference: (provider, model) => { remembered.push({ provider, model }); },
  };
  const props: WorkspaceAgentPickerProps = {
    target: "claude",
    kind: "structured",
    model: "default",
    onTargetChange: (target) => { props.target = target; changes.push(target); },
    onKindChange: (kind) => { props.kind = kind; changes.push(kind); },
    onModelChange: (model) => { props.model = model; changes.push(model); },
    ...overrides,
  };
  const dependencies: Record<string, unknown> = {
    react: {
      ...React,
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
      useEffect: () => {},
    },
    "react/jsx-runtime": jsxRuntime,
    "../model-catalog": MODEL_CATALOG_DEPENDENCY,
    // 目录 hook 单独有单测；这里只要“还没拉到目录”这一种状态。
    "../use-model-catalog": { useWandModelCatalog: () => null },
    "../new-session/choice-navigation": { nextChoice },
    "../new-session/repository": {
      httpNewSessionRepository: {
        loadConfig: () => Promise.resolve({ defaultProvider: "claude", defaultSessionKind: "structured" }),
        savePreferences: (value: unknown) => {
          preferences.push(JSON.parse(JSON.stringify(value)));
          return Promise.resolve();
        },
      },
    },
    "../provider-logo": { ProviderLogo: () => null },
    "../ui": {
      WandButton: () => null,
      WandIcon: () => null,
      WandSelect: WandSelectStub,
    },
    "./controller": { workspacesStore: { getRuntime: () => runtime } },
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

  function modelSelects(): ModelSelectProps[] {
    const result: ModelSelectProps[] = [];
    function visit(node: React.ReactNode): void {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return;
        const type = child.type as unknown as Record<string, unknown> | null;
        if (type && typeof type === "function" && type[WAND_SELECT_MARK] === true) {
          result.push(child.props as unknown as ModelSelectProps);
        }
        visit(child.props.children);
      });
    }
    visit(exports.WorkspaceAgentPicker(props));
    return result;
  }

  function modelSelect(): ModelSelectProps {
    const [first] = modelSelects();
    assert.ok(first, "expected the model select to render");
    return first;
  }

  return {
    props,
    preferences,
    changes,
    radios,
    key,
    modelSelect,
    modelSelects,
    focused: () => focused,
    remembered,
    setRuntime: (next: typeof runtime) => { runtime = next; },
  };
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
  assert.equal(disabled.modelSelect().disabled, true);
});

test("model select is everywhere a provider runs, remembers the pick, and is hidden for shell", () => {
  const h = harness();
  // 目录还没到（vm 里没有 effect）：仍然渲染「跟随服务端默认」占位，不阻塞创建。
  const initial = h.modelSelect();
  assert.equal(initial.value, "default");
  assert.deepEqual(initial.options, [{ value: "default", label: "跟随服务端默认" }]);

  initial.onValueChange!("opus");
  assert.equal(h.props.model, "opus");
  // 选项写回按 provider 的记忆，空串表示「跟随服务端默认」而不是字面量 default。
  assert.deepEqual(h.remembered, [{ provider: "claude", model: "opus" }]);
  h.modelSelect().onValueChange!("default");
  assert.deepEqual(h.remembered.at(-1), { provider: "claude", model: "" });

  // PTY 会话同样按模型启动 CLI，所以模型选择必须在。
  h.radios().get("pty")!.props.onClick();
  assert.equal(h.modelSelect().options.length, 1);

  // 空白终端没有模型可选，交给系统 Shell。
  h.radios().get("shell")!.props.onClick();
  assert.equal(h.modelSelects().length, 0);

  // 只看不选（persistPreferences=false）时不得写偏好。
  const local = harness({ persistPreferences: false });
  local.modelSelect().onValueChange!("haiku");
  assert.deepEqual(local.remembered, []);
  assert.equal(local.props.model, "haiku");
});

test("provider switch hands the caller that provider's remembered model", () => {
  const h = harness();
  h.setRuntime({
    modelPreference: (provider) => (provider === "codex" ? "gpt-5-codex" : ""),
    rememberModelPreference: (provider, model) => { h.remembered.push({ provider, model }); },
  });
  assert.equal(h.key("claude", "ArrowRight"), true);
  assert.equal(h.props.target, "codex");
  // 选择器只负责提示默认值；调用方用 workspaceModelDefault 决定新 provider 的预选。
  assert.equal(h.props.model, "default");
  h.modelSelect().onValueChange!("gpt-5-codex");
  assert.deepEqual(h.remembered.at(-1), { provider: "codex", model: "gpt-5-codex" });
});
