import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerSkillsController,
  type ComposerSkillOption,
  type ComposerSkillsMount,
} from "../src/web-ui/react/composer-skills/controller.ts";
import { ComposerSkillsPopover } from "../src/web-ui/react/composer-skills/host.tsx";

const TARGET = {} as HTMLElement;

const OPTIONS: readonly ComposerSkillOption[] = [
  { name: "code-review", description: "审查改动", sourceLabel: "项目", selected: true },
  { name: "commit-helper", description: "", sourceLabel: "用户", selected: false },
];

function mountFor(
  overrides: Partial<ComposerSkillsMount> = {},
): ComposerSkillsMount {
  return {
    key: "composer-skills",
    target: TARGET,
    loading: false,
    options: OPTIONS,
    selectedCount: 1,
    onToggle() {},
    ...overrides,
  };
}

function render(mount: ComposerSkillsMount): string {
  return renderToStaticMarkup(React.createElement(ComposerSkillsPopover, { mount }));
}

test("Skills 弹层注册表只在选项或计数变化时广播", () => {
  const controller = new ComposerSkillsController();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });

  controller.sync([mountFor()]);
  assert.equal(notifications, 1);
  const first = controller.getSnapshot();

  // toggleClaudeSkill 每次都会重发，回调是新的但选项没变不能广播。
  controller.sync([mountFor()]);
  assert.equal(notifications, 1);
  assert.equal(controller.getSnapshot(), first);

  controller.sync([mountFor({
    options: [{ ...OPTIONS[0], selected: false }, OPTIONS[1]],
    selectedCount: 0,
  })]);
  assert.equal(notifications, 2);

  controller.sync([mountFor({ loading: true, options: [], selectedCount: 0 })]);
  assert.equal(notifications, 3);

  // 关闭弹层 → 适配器传空 mounts。
  controller.clear();
  assert.equal(notifications, 4);
  assert.equal(controller.getSnapshot().mounts.length, 0);
  unsubscribe();
});

test("弹层保留 id / role 与选项的可访问语义", () => {
  const html = render(mountFor());
  assert.match(html, /class="composer-skills-popover" id="composer-skills-popover" role="dialog" aria-label="选择 skills" tabindex="-1"/);
  assert.match(html, /<span class="composer-skills-count">已选 1<\/span>/);
  assert.match(html, /class="composer-skill-option is-selected" type="button" role="checkbox" aria-checked="true" data-claude-skill-name="code-review"/);
  assert.match(html, /class="composer-skill-option" type="button" role="checkbox" aria-checked="false" data-claude-skill-name="commit-helper"/);
  assert.equal((html.match(/class="composer-skill-check"/g) || []).length, 2);
  assert.match(html, /<span class="composer-skill-source">项目<\/span>/);
  assert.match(html, /<span class="composer-skill-source">用户<\/span>/);
  // 描述为空时不渲染 .composer-skill-description
  assert.equal((html.match(/composer-skill-description/g) || []).length, 1);
});

test("找不到选项时不渲染 .hidden，而是切换 loading / 空列表文案", () => {
  const loading = render(mountFor({ loading: true, options: [], selectedCount: 0 }));
  assert.match(loading, /正在加载 skills…/);
  assert.match(loading, /<span class="composer-skills-count">本条不应用<\/span>/);
  assert.doesNotMatch(loading, /class="[^"]*hidden/);

  const empty = render(mountFor({ loading: false, options: [], selectedCount: 0 }));
  assert.match(empty, /当前目录没有可用 skills。/);
});

test("适配器只在打开时发布 mount，legacy 侧不再改写弹层 DOM", () => {
  const adapter = readFileSync(
    new URL("../src/web-ui/browser/composer-skills-adapter.ts", import.meta.url),
    "utf8",
  );
  assert.match(adapter, /if \(!config\.visible\) return null;/);
  assert.match(adapter, /flush: true/);
  assert.match(adapter, /data-composer-skills-host/);

  const sessionEngine = readFileSync(
    new URL("../src/web-ui/browser/session-engine.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sessionEngine, /picker\.outerHTML = markup;/);
  assert.doesNotMatch(sessionEngine, /insertAdjacentElement\("afterend"/);
  assert.doesNotMatch(sessionEngine, /export function renderClaudeSkillsPickerHtml/);
  // 来源标签的翻译规则留在 legacy 侧
  assert.match(sessionEngine, /sourceLabel: skill\.source === "project" \? "项目" : "用户",/);
});

test("选项点击已改由 React 处理，legacy 不再有 data-claude-skill-name 委托", () => {
  const events = readFileSync(
    new URL("../src/web-ui/browser/events.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(events, /target\.closest\("\[data-claude-skill-name\]"\)/);
  // 「点外部关闭」与 Escape 仍然按节点 id 判断，必须保留。
  assert.match(events, /document\.getElementById\("composer-skills-popover"\)/);
  assert.match(events, /e\.key === "Escape"\) closeClaudeSkillsPicker\(\);/);
});
