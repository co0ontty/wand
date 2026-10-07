// Development-only fixtures; production editor, fields, select, styles, and state protection.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { ModelGroupsSettingsPanel } from "../../src/web-ui/react/settings/model-groups-panel.js";
import { normalizeModels } from "../../src/web-ui/react/settings/repository.js";
import { installReactUiStyles } from "../../src/web-ui/react/styles.js";
import { modelGroupSelector, type ModelGroup } from "../../src/model-groups.js";
import type { SettingsCommandResult, SettingsRepository, SettingsSnapshot } from "../../src/web-ui/react/settings/types.js";
installReactUiStyles();
const seed: ModelGroup[] = [{ id: "coding", provider: "claude", name: "编程分组", models: ["first", "second"] },
  { id: "coding", provider: "codex", name: "Codex 分组", models: ["codex-first"] }];
function catalog(groups: ModelGroup[]) {
  return normalizeModels({ modelGroups: groups, freeModels: ["small", "large"].map((id) => ({ id: `wand-openrouter-free/${id}`, label: id })),
    models: [{ id: "first", label: "首选模型" }, { id: "second", label: "备用模型" },
      ...groups.filter((entry) => entry.provider === "claude").map((entry) => ({ id: modelGroupSelector(entry), label: entry.name }))],
    codexModels: [{ id: "codex-first", label: "Codex First" }], piModels: [{ id: "wand-openrouter-free/auto", label: "免费分组" }] });
}
let saved = structuredClone(seed);
const controls = { mode: "success", saves: 0, orders: [] as string[][] };
(window as unknown as { groupHarness: typeof controls }).groupHarness = controls;
const makeSnapshot = (): SettingsSnapshot => ({ access: "admin", config: { modelGroups: saved }, models: catalog(saved) } as SettingsSnapshot);
const repository: SettingsRepository = {
  async load() { return makeSnapshot(); },
  async execute(command) {
    if (command.type !== "modelGroups.save") throw new Error("unexpected");
    controls.saves++;
    await new Promise((resolve) => setTimeout(resolve, 220));
    if (controls.mode === "conflict") throw new Error("模型分组已在其他设备修改，请先刷新；当前草稿已保留。");
    saved = structuredClone(command.value);
    controls.orders = saved.map((entry) => entry.models);
    const config = { modelGroups: saved };
    return { ok: true, config, desiredConfig: config, activeConfig: config, restartRequired: false,
      models: catalog(saved) } as SettingsCommandResult<typeof command>;
  },
};
function Harness(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<SettingsSnapshot | null>(makeSnapshot());
  return <ModelGroupsSettingsPanel snapshot={snapshot!} repository={repository} setSnapshot={setSnapshot} />;
}
createRoot(document.getElementById("root")!).render(<Harness />);
