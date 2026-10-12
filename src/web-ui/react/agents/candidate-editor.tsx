import * as React from "react";
import { Alert, Flex, Space, Tag, Typography, Tooltip } from "antd";
import type { WandTaskAgent } from "../../../task-types.js";
import { WandButton, WandIcon, WandIconButton } from "../ui";
import {
  addCandidate,
  candidateLabel,
  candidateListError,
  duplicateCandidates,
  moveCandidate,
  removeCandidate,
  setCandidate,
} from "./candidate-list.js";
import { AgentFields } from "../issues/agent-fields.js";
import type { IssueAgentProvider, IssueModelCatalog } from "../issues/task-board-agent.js";
import { AI_TEAM_MAX_CANDIDATES } from "../../../ai-team-types.js";
import { installEmployeeStyles } from "./styles.js";

export type ProviderOptions = Array<{ value: IssueAgentProvider; label: string }> | null;

export {
  addCandidate,
  candidateLabel,
  candidateListError,
  duplicateCandidates,
  moveCandidate,
  removeCandidate,
  setCandidate,
};

export interface CandidateRowProps {
  id: string;
  agent: WandTaskAgent;
  index: number;
  total: number;
  catalog: IssueModelCatalog | null;
  providerOptions: ProviderOptions;
  disabled: boolean;
  duplicate: boolean;
  ariaPrefix: string;
  structuredOnly?: boolean;
  onChange(next: WandTaskAgent): void;
  onMove(delta: number): void;
  onRemove(): void;
}

/** 一行候选：连续行与分隔线表达顺序，控件复用公共 owner。 */
export function CandidateEditorRow({
  id,
  agent,
  index,
  total,
  catalog,
  providerOptions,
  disabled,
  duplicate,
  ariaPrefix,
  structuredOnly = false,
  onChange,
  onMove,
  onRemove,
}: CandidateRowProps): React.ReactElement {
  const label = candidateLabel(index);

  return (
    <div
      data-candidate-id={id}
      className="wand-team-candidate"
      data-candidate-index={index}
      data-duplicate={duplicate || undefined}
    >
      <Flex align="start" gap={8} wrap className="wand-team-candidate-inner">
        <Tag color={duplicate ? "error" : undefined} className="wand-team-candidate-tag">{label}</Tag>
        <Flex wrap gap={8} className="wand-ai-team-member-agent" style={{ flex: "1 1 200px", minWidth: 0 }}>
          <AgentFields
            agent={agent}
            disabled={disabled}
            catalog={catalog}
            providerOptions={providerOptions}
            ariaPrefix={`${ariaPrefix} ${label}`}
            showKind={!structuredOnly}
            allowSdkEngine
            onChange={(next) => onChange(structuredOnly ? { ...next, kind: "structured" } : next)}
          />
        </Flex>
        <Space className="wand-team-candidate-tools" size={4}>
          <Tooltip title="上移">
            <WandIconButton
              data-tool="up"
              aria-label={`把${label}上移`}
              disabled={disabled || index === 0}
              onClick={() => onMove(-1)}
            >
              <WandIcon name="chevronUp" size={14} />
            </WandIconButton>
          </Tooltip>
          <Tooltip title="下移">
            <WandIconButton
              data-tool="down"
              aria-label={`把${label}下移`}
              disabled={disabled || index === total - 1}
              onClick={() => onMove(1)}
            >
              <WandIcon name="chevronDown" size={14} />
            </WandIconButton>
          </Tooltip>
          <Tooltip title={total <= 1 ? "至少要保留 1 个候选" : "删除该候选"}>
            <WandIconButton
              data-tool="remove"
              aria-label={`删除${label}`}
              disabled={disabled || total <= 1}
              onClick={onRemove}
            >
              <WandIcon name="close" size={14} />
            </WandIconButton>
          </Tooltip>
        </Space>
      </Flex>
    </div>
  );
}

/**
 * 带有 FLIP 动画与高度过渡的候选列表容器，禁止整表重挂载（移除 listKey）。
 * FLIP 只读 `data-candidate-id` 的位移，所以容器换成通用卡片后顺序动画仍按同一份数据算。
 */
export function CandidatesListEditor({
  agents,
  label,
  catalog,
  providerOptions,
  disabled,
  structuredOnly = false,
  onChange,
}: {
  agents: WandTaskAgent[];
  label: string;
  catalog: IssueModelCatalog | null;
  providerOptions: ProviderOptions;
  disabled: boolean;
  structuredOnly?: boolean;
  onChange(agents: WandTaskAgent[]): void;
}): React.ReactElement {
  React.useEffect(() => { installEmployeeStyles(); }, []);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const prevPositions = React.useRef<Map<string, number>>(new Map());

  // 为每个 item 维持稳定的内部唯一 key，防止由于下标重用导致 FLIP 计算错误
  const keysRef = React.useRef<string[]>([]);
  while (keysRef.current.length < agents.length) {
    keysRef.current.push(`c_${Math.random().toString(36).slice(2, 9)}`);
  }
  if (keysRef.current.length > agents.length) {
    keysRef.current = keysRef.current.slice(0, agents.length);
  }

  // FLIP: 使用 React ref 获取行容器与子节点，避免在业务代码中使用 querySelector / getElementById
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Collapse force-renders its editor while closed. Hidden coordinates are not
    // a reorder origin: replaying them on disclosure sends fields above the card.
    if (container.closest("[inert], [hidden]") || container.getBoundingClientRect().height === 0) {
      prevPositions.current.clear();
      return;
    }

    const children = Array.from(container.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-candidate-id"),
    );
    const currentPositions = new Map<string, number>();

    children.forEach((row) => {
      const id = row.getAttribute("data-candidate-id");
      if (id) {
        currentPositions.set(id, row.getBoundingClientRect().top);
      }
    });

    const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // 计算 FLIP
    children.forEach((row) => {
      const id = row.getAttribute("data-candidate-id");
      if (!id) return;
      const prevTop = prevPositions.current.get(id);
      const currTop = currentPositions.get(id);

      if (prevTop !== undefined && currTop !== undefined && prevTop !== currTop) {
        if (reduceMotion) {
          // 在 prefers-reduced-motion 下直接跳过位移动画进行瞬时退化
          row.style.transform = "";
          row.style.transition = "";
          return;
        }
        const deltaY = prevTop - currTop;
        // Invert
        row.style.transform = `translateY(${deltaY}px)`;
        row.style.transition = "none";

        // Play
        requestAnimationFrame(() => {
          row.style.transition = "transform var(--motion-normal) var(--ease-in-out-smooth)";
          row.style.transform = "";
        });
      }
    });

    prevPositions.current = currentPositions;
  });

  const duplicates = duplicateCandidates(agents);
  const listError = candidateListError(agents);

  const addRow = (): void => {
    const next = addCandidate(agents);
    if (next === agents) return;
    keysRef.current.push(`c_${Math.random().toString(36).slice(2, 9)}`);
    onChange(next);
  };

  const removeRow = (at: number): void => {
    if (agents.length <= 1) return;
    keysRef.current.splice(at, 1);
    onChange(removeCandidate(agents, at));
  };

  const moveRow = (at: number, delta: number): void => {
    const target = at + delta;
    if (target < 0 || target >= agents.length) return;
    // 交换 keys
    const k = keysRef.current[at]!;
    keysRef.current[at] = keysRef.current[target]!;
    keysRef.current[target] = k;
    onChange(moveCandidate(agents, at, delta));
  };

  return (
    <section
      className="wand-team-candidates"
      role="group"
      aria-label={`${label} 的执行候选`}
    >
      <Flex vertical gap={8}>
      <Flex component="header" wrap align="baseline" gap={8} className="wand-team-candidates-head">
        <Typography.Text strong>执行候选</Typography.Text>
        <Typography.Text type="secondary">首选不可用时按顺序自动降级，最多 {AI_TEAM_MAX_CANDIDATES} 个</Typography.Text>
      </Flex>
      <Flex vertical gap={8} ref={containerRef}>
      {agents.map((agent, at) => {
        const rowId = keysRef.current[at] || `row-${at}`;
        return (
          <CandidateEditorRow
            key={rowId}
            id={rowId}
            agent={agent}
            index={at}
            total={agents.length}
            catalog={catalog}
            providerOptions={providerOptions}
            disabled={disabled}
            duplicate={duplicates.includes(at)}
            ariaPrefix={label}
            structuredOnly={structuredOnly}
            onChange={(next) => onChange(setCandidate(agents, at, next))}
            onMove={(delta) => moveRow(at, delta)}
            onRemove={() => removeRow(at)}
          />
        );
      })}
      </Flex>
      <Flex wrap align="center" gap={10} className="wand-team-candidates-foot">
        <WandButton
          kind="ghost"
          size="small"
          disabled={disabled || agents.length >= AI_TEAM_MAX_CANDIDATES}
          title={
            agents.length >= AI_TEAM_MAX_CANDIDATES
              ? `已经到 ${AI_TEAM_MAX_CANDIDATES} 个候选上限`
              : "在末尾加一个备用候选"
          }
          onClick={addRow}
        >
          <WandIcon name="plus" size={14} slot="start" />
          <span>添加候选</span>
        </WandButton>
        {listError ? (
          <Alert type="error" showIcon className="wand-team-candidate-error" role="alert" title={listError} />
        ) : null}
      </Flex>
      </Flex>
    </section>
  );
}
