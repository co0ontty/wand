import * as React from "react";
import { Alert, Checkbox, Empty, Flex, Spin, Typography } from "antd";
import { isBuiltinSiliconEmployee, siliconEmployeeTags, type SiliconEmployee } from "../../../ai-team-types.js";
import { WandButton, WandIcon, WandSearchField } from "../ui";
import { EmployeeCard } from "./employee-card.js";
import { EmployeeCreateForm } from "./employee-create-form.js";
import { useSiliconEmployees, siliconEmployeesRepository } from "./employee-repository.js";
import type { IssueModelCatalog } from "../issues/task-board-agent.js";
import type { ProviderOptions } from "./candidate-editor.js";
import type { WandTaskAgent } from "../../../task-types.js";
import { wandOverlay } from "../overlay-controller.js";

export function EmployeeListPage({
  catalog,
  providerOptions,
}: {
  catalog: IssueModelCatalog | null;
  providerOptions: ProviderOptions;
}): React.ReactElement {
  const { employees, loading, error, reload } = useSiliconEmployees({ includeArchived: true });
  const [query, setQuery] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [mutationError, setMutationError] = React.useState("");

  const filtered = React.useMemo(() => {
    return employees.filter((emp) => {
      if (!showArchived && emp.archivedAt) return false;
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return (
        emp.name.toLowerCase().includes(q) ||
        emp.duty.toLowerCase().includes(q) ||
        emp.prompt.toLowerCase().includes(q) ||
        siliconEmployeeTags(emp).some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [employees, showArchived, query]);

  const handleCreate = async (draft: {
    name: string;
    duty: string;
    prompt: string;
    avatar: string;
    tags: string[];
    agents: WandTaskAgent[];
  }) => {
    await siliconEmployeesRepository.create(draft);
    setIsCreating(false);
    reload();
  };

  const handleSave = async (id: string, patch: Partial<SiliconEmployee>) => {
    const current = employees.find((e) => e.id === id);
    if (!current) return;
    // 自动记忆更新可能刚好发生在编辑期间；内置员工只回传候选，不能拿旧 Prompt 覆盖它。
    await siliconEmployeesRepository.update(id, isBuiltinSiliconEmployee(current)
      ? { agents: patch.agents ?? current.agents }
      : {
          name: patch.name ?? current.name,
          duty: patch.duty ?? current.duty,
          prompt: patch.prompt ?? current.prompt,
          avatar: patch.avatar ?? current.avatar,
          tags: patch.tags ?? current.tags ?? [],
          agents: patch.agents ?? current.agents,
        });
    reload();
  };

  const handleArchive = async (id: string) => {
    try {
      setMutationError("");
      await siliconEmployeesRepository.archive(id);
      reload();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "归档员工失败。");
    }
  };

  const handleUnarchive = async (id: string) => {
    try {
      setMutationError("");
      await siliconEmployeesRepository.unarchive(id);
      reload();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "恢复员工失败。");
    }
  };

  const handleDelete = async (id: string) => {
    const employee = employees.find((item) => item.id === id);
    if (!employee) return;
    const answer = await wandOverlay.dialog({
      title: `删除员工「${employee.name}」？`,
      description: "员工配置和其独立知识库将被删除；已有会话与历史消息会保留。",
      actions: [
        { label: "取消", value: false, autoFocus: true },
        { label: "删除员工", value: true, kind: "danger" },
      ],
    });
    if (answer.dismissed === true || !answer.action) return;
    try {
      setMutationError("");
      await siliconEmployeesRepository.remove(id);
      reload();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "删除员工失败。");
    }
  };

  return (
    <Flex vertical gap={16} className="wand-employee-list">
      <Flex component="header" wrap align="center" justify="space-between" gap={12} className="wand-teams-toolbar">
        <Flex className="wand-teams-toolbar-search" style={{ flex: "1 1 240px", maxWidth: 400, minWidth: 0 }}>
          <WandSearchField
            value={query}
            label="搜索员工名字、标签、职责或 Prompt"
            placeholder="搜索员工名字、标签、职责或 Prompt…"
            onValueChange={setQuery}
          />
        </Flex>
        <Flex wrap align="center" gap={12} className="wand-teams-toolbar-actions">
          <Checkbox
            className="wand-employee-filter-toggle"
            checked={showArchived}
            disabled={loading}
            onChange={(event) => setShowArchived(event.target.checked)}
          >
            显示归档
          </Checkbox>
          <WandButton
            kind="primary"
            disabled={isCreating}
            onClick={() => setIsCreating(true)}
          >
            <WandIcon name="plus" size={14} slot="start" />
            新建员工
          </WandButton>
        </Flex>
      </Flex>

      {error ? (
        <Alert
          className="wand-team-candidate-error"
          type="error"
          showIcon
          role="alert"
          title="读取员工列表失败"
          description={error}
          action={<WandButton kind="ghost" size="small" onClick={reload}>重新加载</WandButton>}
        />
      ) : null}
      {mutationError
        ? <Alert className="wand-team-candidate-error" type="error" showIcon role="alert" title={mutationError} />
        : null}

      <Flex vertical gap={12} className="wand-team-members">
        {isCreating ? (
          <EmployeeCreateForm
            catalog={catalog}
            providerOptions={providerOptions}
            onSave={handleCreate}
            onCancel={() => setIsCreating(false)}
          />
        ) : null}

        {loading && employees.length === 0 ? (
          <Typography.Text type="secondary" className="wand-teams-empty" role="status">
            <Spin size="small"/> 正在加载员工列表…
          </Typography.Text>
        ) : null}

        {!loading && filtered.length === 0 && !isCreating ? (
          <Empty
            className="wand-teams-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={query
              ? "没有匹配的员工"
              : "还没有硅基员工。创建一个角色，并为它配置专属的执行工具链吧！"}
          >
            {!query ? (
              <WandButton kind="primary" onClick={() => setIsCreating(true)}>
                <WandIcon name="plus" size={14} slot="start" />
                创建你的第一个硅基员工
              </WandButton>
            ) : null}
          </Empty>
        ) : null}

        {filtered.map((employee) => (
          <EmployeeCard
            key={employee.id}
            employee={employee}
            catalog={catalog}
            providerOptions={providerOptions}
            onSave={(patch) => handleSave(employee.id, patch)}
            onArchive={() => handleArchive(employee.id)}
            onUnarchive={() => handleUnarchive(employee.id)}
            onDelete={() => handleDelete(employee.id)}
          />
        ))}
      </Flex>
    </Flex>
  );
}
