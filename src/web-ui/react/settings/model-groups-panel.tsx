import * as React from "react";
import { Collapse, Tag } from "antd";
import { useEffect, useState } from "react";
import { FREE_MODEL_GROUP_ID, MODEL_GROUP_MAX_MEMBERS, MODEL_GROUP_MAX_PER_PROVIDER,
  isModelGroupSelector, normalizeModelGroups, orderModelIds, type ModelGroup } from "../../../model-groups.js";
import { OPENROUTER_FREE_GROUP, OPENROUTER_FREE_SELECTOR } from "../../../openrouter-free-selection.js";
import { PROVIDER_LABELS, SESSION_PROVIDERS } from "../../../provider-catalog.js";
import { WandButton, WandIcon, WandIconButton } from "../ui";
import { SettingsField, SettingsSaveBar, SettingsSection, SettingsSelect, SettingsTextInput } from "./fields";
import { failureMessage } from "../errors";
import type { SettingsTabProps } from "./tabs";
import type { SettingsModelCatalog, SettingsModelOption, SettingsSessionProvider } from "./types";

export function groupEditorModels(catalog: SettingsModelCatalog | null, provider: SettingsSessionProvider): SettingsModelOption[] {
  const key = provider === "claude" ? "models" : `${provider}Models` as keyof SettingsModelCatalog;
  const list = (catalog?.[key] ?? []) as SettingsModelOption[];
  return [...list, ...(provider === "pi" ? catalog?.freeModels ?? [] : [])]
    .filter((model) => model.id !== "default" && model.id !== OPENROUTER_FREE_SELECTOR && !isModelGroupSelector(model.id));
}

export function modelGroupsDraft(saved: readonly ModelGroup[], catalog: SettingsModelCatalog | null): ModelGroup[] {
  const groups = structuredClone([...saved]);
  const free = groups.find((entry) => entry.id === FREE_MODEL_GROUP_ID && entry.provider === "pi");
  const members = orderModelIds((catalog?.freeModels ?? []).map((model) => model.id), free?.models ?? []);
  if (free) free.models = members;
  else if (catalog?.freeModels !== undefined) groups.push({ id: FREE_MODEL_GROUP_ID, provider: "pi", name: OPENROUTER_FREE_GROUP, models: members });
  return groups;
}

export function moveGroupModel(group: ModelGroup, index: number, delta: number): ModelGroup {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= group.models.length) return group;
  const models = [...group.models];
  [models[index], models[target]] = [models[target]!, models[index]!];
  return { ...group, models };
}

function GroupEditor({ group, catalog, disabled, onChange, onRemove }: {
  group: ModelGroup; catalog: SettingsModelCatalog | null; disabled: boolean;
  onChange(group: ModelGroup): void; onRemove(): void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(group.id !== FREE_MODEL_GROUP_ID && !group.models.length);
  const [model, setModel] = useState("");
  const [remove, setRemove] = useState(false);
  const free = group.id === FREE_MODEL_GROUP_ID;
  const suggestions = free ? catalog?.freeModels ?? [] : groupEditorModels(catalog, group.provider);
  const available = suggestions.filter((entry) => !group.models.includes(entry.id));
  const key = `${group.provider}-${group.id}`;
  return <Collapse activeKey={expanded ? [key] : []}
    onChange={(keys) => { setExpanded(keys.includes(key)); setRemove(false); }}
    items={[{ key, label: group.name || "未命名分组", collapsible: disabled ? "disabled" : undefined,
      extra: <Tag>{group.models.length} 个模型</Tag>, children: <div className="wand-settings-library-group-content">
        {!free ? <SettingsField label="分组名称" htmlFor={`name-${key}`}>
          <SettingsTextInput id={`name-${key}`} value={group.name} disabled={disabled}
            onChange={(name) => onChange({ ...group, name })} />
        </SettingsField> : <p>只用已验证且仍免费的模型；新成员追加到末尾，收费或下架的自动跳过。</p>}
        <ol className="wand-settings-library-group-members" aria-label={`${group.name} 的模型顺序`}>
          {group.models.map((id, index) => <li key={id}>
            <span className="wand-settings-library-group-member-name">{index === 0 ? "首选" : `候选 ${index + 1}`} · {suggestions.find((entry) => entry.id === id)?.label || id}</span>
            <div className="wand-settings-library-group-tools">
              <WandIconButton kind="ghost" size="small" aria-label={`上移模型 ${index + 1}`}
                disabled={disabled || index === 0} onClick={() => onChange(moveGroupModel(group, index, -1))}><WandIcon name="chevronUp" size={14} /></WandIconButton>
              <WandIconButton kind="ghost" size="small" aria-label={`下移模型 ${index + 1}`}
                disabled={disabled || index === group.models.length - 1} onClick={() => onChange(moveGroupModel(group, index, 1))}><WandIcon name="chevronDown" size={14} /></WandIconButton>
              {!free ? <WandIconButton kind="ghost" size="small" aria-label={`移除模型 ${index + 1}`}
                disabled={disabled} onClick={() => onChange({ ...group, models: group.models.filter((entry) => entry !== id) })}><WandIcon name="close" size={14} /></WandIconButton> : null}
            </div>
          </li>)}
        </ol>
        {!group.models.length ? <p>{free ? "尚无已验证的免费模型，请先配置 OpenRouter Key 并同步。" : "请添加至少一个具体模型。"}</p> : null}
        {!free ? <>
          <SettingsSelect id={`add-${key}`} ariaLabel="从目录添加模型" value="" searchable
            options={[{ value: "", label: "从目录添加模型…" }, ...available.map((entry) => ({ value: entry.id, label: entry.label }))]}
            disabled={disabled || group.models.length >= MODEL_GROUP_MAX_MEMBERS}
            onChange={(id) => { if (id) onChange({ ...group, models: [...group.models, id] }); }} />
          <div className="wand-settings-library-group-custom">
            <SettingsTextInput id={`custom-${key}`} placeholder="或输入自定义模型 ID" value={model}
              disabled={disabled} onChange={setModel} />
            <WandButton kind="secondary" size="small" disabled={disabled || !model.trim()
              || group.models.includes(model.trim()) || isModelGroupSelector(model.trim())
              || model.trim() === OPENROUTER_FREE_SELECTOR || group.models.length >= MODEL_GROUP_MAX_MEMBERS}
              onClick={() => { onChange({ ...group, models: [...group.models, model.trim()] }); setModel(""); }}>添加模型</WandButton>
          </div>
          <div className="wand-settings-library-group-custom">
            <WandButton kind="ghost" size="small" disabled={disabled} onClick={() => setRemove(!remove)}>{remove ? "取消删除" : "删除分组"}</WandButton>
            {remove ? <WandButton kind="danger" size="small" disabled={disabled} onClick={onRemove}>确认删除分组</WandButton> : null}
          </div>
          {remove ? <p>删除后不会改写历史；仍引用该分组的会话和员工需要重新选择。</p> : null}
        </> : null}
      </div> }]} />;
}

export function ModelGroupsSettingsPanel({ snapshot, repository, setSnapshot }: Pick<SettingsTabProps,
  "snapshot" | "repository" | "setSnapshot">): React.ReactElement {
  const saved = snapshot.config?.modelGroups ?? [];
  const [base, setBase] = useState(() => structuredClone(saved));
  const [groups, setGroups] = useState(() => modelGroupsDraft(saved, snapshot.models));
  const [provider, setProvider] = useState<SettingsSessionProvider>("claude");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"info" | "success" | "error">("info");
  useEffect(() => {
    if (!dirty && !pending) { setBase(structuredClone(saved)); setGroups(modelGroupsDraft(saved, snapshot.models)); }
  }, [snapshot.config?.modelGroups, snapshot.models, dirty, pending]);
  const edit = (next: ModelGroup[]): void => { setGroups(next); setDirty(true); setStatus(""); setDiscard(false); };
  const visible = groups.filter((group) => group.provider === provider);
  async function reload(): Promise<void> {
    setPending(true); setStatus("");
    try {
      const next = await repository.load();
      if (!next.config || !next.models) throw new Error("未取得完整配置，当前草稿已保留。");
      setBase(structuredClone(next.config.modelGroups ?? []));
      setGroups(modelGroupsDraft(next.config.modelGroups ?? [], next.models));
      setDirty(false); setDiscard(false); setSnapshot(next); setTone("success"); setStatus("模型分组与目录已重新加载。");
    } catch (cause) { setStatus(failureMessage(cause, "加载失败，草稿已保留。")); setTone("error"); }
    finally { setPending(false); }
  }
  async function save(): Promise<void> {
    if (pending) return;
    setPending(true); setStatus("");
    try {
      const result = await repository.execute({ type: "modelGroups.save", value: normalizeModelGroups(groups), expected: base });
      setBase(structuredClone(result.config.modelGroups ?? [])); setDirty(false);
      setSnapshot((current) => current ? { ...current, config: result.config,
        desiredConfig: result.desiredConfig, activeConfig: result.activeConfig,
        models: result.models ?? current.models } : current);
      setStatus(result.models ? "模型分组与顺序已保存，所有选择器立即生效。" : "已保存；目录刷新失败，请刷新后查看选择器。"); setTone("success");
    } catch (cause) { setStatus(failureMessage(cause, "保存模型分组失败，草稿已保留。")); setTone("error"); }
    finally { setPending(false); }
  }
  return <SettingsSection title="模型分组" description="每个工具可配置多个分组，聊天、任务和员工的模型选择器都可直接选组。首选在前；仅明确未接受输入的启动失败才尝试下一项，运行中错误不会自动重发。终端只使用首选模型。">
    <SettingsSelect id="settings-model-group-provider" ariaLabel="配置模型分组的工具" value={provider}
      disabled={pending} options={SESSION_PROVIDERS.map((id) => ({ value: id, label: PROVIDER_LABELS[id] }))}
      onChange={(id) => setProvider(id as SettingsSessionProvider)} />
    {visible.map((group) => <GroupEditor key={`${group.provider}/${group.id}`} group={group} catalog={snapshot.models} disabled={pending}
      onChange={(next) => edit(groups.map((item) => item.id === group.id && item.provider === provider ? next : item))}
      onRemove={() => edit(groups.filter((item) => item.id !== group.id || item.provider !== provider))} />)}
    <WandButton kind="secondary" size="small" disabled={pending || visible.filter((entry) => entry.id !== FREE_MODEL_GROUP_ID).length >= MODEL_GROUP_MAX_PER_PROVIDER}
      onClick={() => {
        let number = 1;
        while (visible.some((entry) => entry.name === `分组 ${number}`)) number++;
        const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        edit([...groups, { id: `g_${id}`, provider, name: `分组 ${number}`, models: [] }]);
      }}>添加分组</WandButton>
    <div className="wand-settings-library-group-custom">
      <WandButton kind="ghost" size="small" disabled={pending}
        onClick={() => dirty ? setDiscard(!discard) : void reload()}>{dirty ? discard ? "取消放弃" : "放弃草稿并重载" : "刷新分组与目录"}</WandButton>
      {discard ? <WandButton kind="danger" size="small" disabled={pending} onClick={() => void reload()}>确认放弃当前草稿</WandButton> : null}
    </div>
    <SettingsSaveBar label="保存模型分组" pending={pending} disabled={!dirty || !snapshot.models}
      onSave={() => void save()} status={status} tone={tone} />
  </SettingsSection>;
}
