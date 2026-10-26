import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createImeGuard } from "../src/web-ui/react/composer-sender/ime-guard.ts";
import { registerPopupDismiss } from "../src/web-ui/react/ui/popup-lifecycle.ts";

test("candidate confirmation cannot submit or dismiss, including Safari compositionend before keydown", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const ime = createImeGuard();
  const enter = { keyCode: 13, isComposing: false };
  assert.equal(ime.shouldIgnore(enter), false);
  ime.onCompositionStart();
  assert.equal(ime.shouldIgnore(enter), true, "active composition protects keys with missing native flags");
  ime.onCompositionEnd();
  assert.equal(ime.shouldIgnore(enter), true, "WebKit's trailing candidate confirmation remains protected");
  context.mock.timers.tick(1);
  assert.equal(ime.shouldIgnore(enter), false, "a subsequent deliberate Enter can submit");
  assert.equal(ime.shouldIgnore({ isComposing: true }), true);
  assert.equal(ime.shouldIgnore({ keyCode: 229 }), true);
  assert.equal(ime.shouldIgnore({ nativeEvent: { isComposing: true } }), true);
  assert.equal(ime.shouldIgnore({ nativeEvent: { keyCode: 229 } }), true);
  ime.reset();
});

test("a previous composition's timer cannot release a newer candidate or an unmounted input", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const ime = createImeGuard();
  ime.onCompositionStart();
  ime.onCompositionEnd();
  ime.onCompositionStart();
  context.mock.timers.tick(1);
  assert.equal(ime.isComposing(), true);
  ime.onCompositionEnd();
  ime.reset();
  assert.equal(ime.isComposing(), false);
  ime.onCompositionStart();
  context.mock.timers.tick(1);
  assert.equal(ime.isComposing(), true, "reset cancelled the old input's deferred release");
  ime.reset();
});

test("Portal popup capture preserves IME Escape before the input handler and releases its listener", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const descriptors = ["document", "window"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const document = new EventTarget();
  const window = new EventTarget();
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  let dismissed = 0;
  let libraryEscapes = 0;
  const release = registerPopupDismiss(() => { dismissed += 1; });
  document.addEventListener("keydown", () => { libraryEscapes += 1; });
  const escape = (keyCode = 27): Event => {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperties(event, { key: { value: "Escape" }, keyCode: { value: keyCode }, isComposing: { value: false } });
    document.dispatchEvent(event);
    return event;
  };
  try {
    assert.equal(escape(229).defaultPrevented, false);
    document.dispatchEvent(new Event("compositionstart"));
    assert.equal(escape().defaultPrevented, false);
    document.dispatchEvent(new Event("compositionend"));
    assert.equal(escape().defaultPrevented, false);
    assert.equal(dismissed, 0);
    assert.equal(libraryEscapes, 0, "candidate Escape cannot reach the library's additional dismissal listener");
    context.mock.timers.tick(1);
    assert.equal(escape().defaultPrevented, true);
    assert.equal(dismissed, 1);
    document.dispatchEvent(new Event("compositionstart"));
    document.dispatchEvent(new Event("focusout"));
    assert.equal(escape().defaultPrevented, true, "moving away from an abandoned composition does not trap the popup");
    release();
    assert.equal(escape().defaultPrevented, false);
    assert.equal(libraryEscapes, 1, "the last lease releases event ownership");
  } finally {
    release();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("search keeps composition private while accepting the trailing committed text before keyboard guard release", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const ime = createImeGuard();
  const searches: string[] = [];
  const changes: string[] = [];
  const source = readFileSync(new URL("../src/web-ui/react/ui/search-field.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const dependencies: Record<string, unknown> = {
    react: { useRef: (current: unknown) => ({ current }) },
    "react/jsx-runtime": { jsx: (type: unknown, props: unknown) => ({ type, props }) },
    "./icons": { WandIcon: () => null },
    "./input": { WandInput: () => null },
    "./class-names": { classNames: (...values: unknown[]) => values.filter(Boolean).join(" ") },
    "../composer-sender/ime-guard": { useImeGuard: () => ime },
  };
  const exports: Record<string, (props: unknown) => { props: Record<string, (...args: any[]) => void> }> = {};
  runInNewContext(outputText, { exports, require: (id: string) => {
    assert.ok(id in dependencies, `unexpected dependency: ${id}`);
    return dependencies[id];
  } });
  const field = exports.WandSearchField({ value: "中文", label: "搜索任务", onValueChange: (value: string) => changes.push(value), onSearch: (value: string) => searches.push(value) }).props;
  field.onCompositionStart();
  field.onChange({ currentTarget: { value: "zhong" } });
  assert.deepEqual(searches, [], "uncommitted candidates do not filter results");
  field.onCompositionEnd({ currentTarget: { value: "中" } });
  field.onChange({ currentTarget: { value: "中文" } });
  assert.deepEqual(searches, ["中", "中文"], "WebKit's final input after compositionend must not be dropped");
  let prevented = false;
  const escape = { key: "Escape", nativeEvent: { isComposing: false, keyCode: 27 }, preventDefault: () => { prevented = true; }, stopPropagation() {} };
  field.onKeyDown(escape);
  assert.equal(prevented, false);
  assert.deepEqual(changes, ["zhong", "中文"]);
  context.mock.timers.tick(1);
  field.onKeyDown(escape);
  assert.equal(prevented, true);
  assert.equal(searches.at(-1), "");
  assert.equal(changes.at(-1), "");
  ime.reset();
});
