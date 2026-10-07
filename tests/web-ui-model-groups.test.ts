import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { modelGroupSelector, type ModelGroup } from "../src/model-groups.js";
import { SESSION_PROVIDERS } from "../src/provider-catalog.js";
import { modelDisplayName } from "../src/web-ui/browser/composer-select-values.js";
import { normalizeWandModelCatalog, pickedModelId, wandModelDisplayName, wandModelOptions } from "../src/web-ui/react/model-catalog.js";
import { ModelGroupsSettingsPanel, groupEditorModels, modelGroupsDraft, moveGroupModel } from "../src/web-ui/react/settings/model-groups-panel.js";
import { normalizeModels } from "../src/web-ui/react/settings/repository.js";
import type { SettingsSnapshot } from "../src/web-ui/react/settings/types.js";

const group: ModelGroup = { id: "coding", provider: "pi", name: "编程分组", models: ["first", "second"] };

for (const provider of SESSION_PROVIDERS) {
  test(`${provider}: Web 会话/员工/任务可选分组，默认与显式展示分组名`, () => {
    const selected = modelGroupSelector({ ...group, provider });
    const key = provider === "claude" ? "models" : `${provider}Models`;
    const catalog = normalizeWandModelCatalog({ [key]: [{ id: selected, label: "编程分组", group: "模型分组" }],
      defaultModels: { [provider]: selected } });
    assert.deepEqual(wandModelOptions(catalog, provider)[1], { value: selected, label: "编程分组", group: "模型分组" });
    assert.equal(pickedModelId(selected), selected);
    assert.equal(wandModelDisplayName(catalog, provider, selected), "编程分组");
    assert.equal(wandModelDisplayName(catalog, provider, "default"), "编程分组");
    assert.equal(modelDisplayName(selected, [{ id: selected, label: "编程分组" }], ""), "编程分组");
    assert.equal(wandModelDisplayName(null, provider, selected), "模型分组", "目录未加载时不编造删除事实");
    assert.equal(modelDisplayName(selected, [], ""), "模型分组");
  });
}

test("编辑组模型时排除哨兵与嵌套分组，允许具体免费成员和自定义ID", () => {
  const catalog = normalizeModels({ piModels: [{ id: "default", label: "默认" }, { id: "first", label: "First" },
    { id: "wand-openrouter-free/auto", label: "免费分组" }, { id: modelGroupSelector(group), label: group.name }],
    freeModels: [{ id: "wand-openrouter-free/small", label: "小模型" }] });
  assert.deepEqual(groupEditorModels(catalog, "pi").map((model) => model.id), ["first", "wand-openrouter-free/small"]);
  assert.deepEqual(groupEditorModels(catalog, "claude"), []);
});

test("免费组保留用户顺序，新验证成员末尾追加，不覆盖其他工具的组", () => {
  const saved: ModelGroup[] = [group, { id: "openrouter-free", provider: "pi", name: "免费分组",
    models: ["wand-openrouter-free/small", "wand-openrouter-free/gone", "wand-openrouter-free/large"] }];
  const catalog = normalizeModels({ freeModels: ["large", "small", "new"].map((id) => ({ id: `wand-openrouter-free/${id}`, label: id })) });
  const draft = modelGroupsDraft(saved, catalog);
  assert.deepEqual(draft[1]!.models, ["wand-openrouter-free/small", "wand-openrouter-free/large", "wand-openrouter-free/new"]);
  assert.deepEqual(saved[1]!.models, ["wand-openrouter-free/small", "wand-openrouter-free/gone", "wand-openrouter-free/large"]);
  assert.deepEqual(moveGroupModel(group, 1, -1).models, ["second", "first"]);
  assert.deepEqual(group.models, ["first", "second"]);
  assert.equal(moveGroupModel(group, 0, -1), group);
});

test("分组配置就地展开，按工具查看与保存，免费组仅能排序，关闭时懒挂载编辑器", () => {
  const snapshot = { config: { modelGroups: [{ ...group, provider: "claude" }] }, models: normalizeModels({
    models: [{ id: "first", label: "First" }], freeModels: [],
  }) } as SettingsSnapshot;
  const markup = renderToStaticMarkup(React.createElement(ModelGroupsSettingsPanel, {
    snapshot, repository: { async load() { return snapshot; }, async execute() { throw new Error("not called"); } }, setSnapshot() {},
  }));
  assert.match(markup, /配置模型分组的工具/);
  assert.match(markup, /编程分组/);
  assert.match(markup, /ant-collapse-header/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /上移模型 2|下移模型 1/, "closed library disclosures lazily mount their editor");
  assert.match(markup, /保存模型分组/);
  const panel = readFileSync(new URL("../src/web-ui/react/settings/model-groups-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /moveGroupModel\(group, index, -1\)/);
  assert.match(panel, /moveGroupModel\(group, index, 1\)/);
  assert.match(panel, /const free = group.id === FREE_MODEL_GROUP_ID/);
  const android = readFileSync(new URL("../android/app/src/main/java/com/wand/app/ui/screens/ModelGroupsSettingsPanel.kt", import.meta.url), "utf8");
  assert.match(android, /WandInlinePanel/);
  assert.match(android, /moveGroupModel\(group, index, -1\)/);
  assert.match(android, /moveGroupModel\(group, index, 1\)/);
});
