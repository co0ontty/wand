import * as React from "react";
import { isSystemSiliconEmployee, type SiliconEmployee } from "../../../ai-team-types.js";
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
        emp.prompt.toLowerCase().includes(q)
      );
    });
  }, [employees, showArchived, query]);

  const handleCreate = async (draft: {
    name: string;
    duty: string;
    prompt: string;
    avatar: string;
    agents: WandTaskAgent[];
  }) => {
    await siliconEmployeesRepository.create(draft);
    setIsCreating(false);
    reload();
  };

  const handleSave = async (id: string, patch: Partial<SiliconEmployee>) => {
    const current = employees.find((e) => e.id === id);
    if (!current) return;
    // 内置员工的名字/职责/人设/头像由服务端定义：只回传候选，别把锁定字段带过去。
    const lockedSource = isSystemSiliconEmployee(current) ? current : patch;
    await siliconEmployeesRepository.update(id, {
      name: lockedSource.name ?? current.name,
      duty: lockedSource.duty ?? current.duty,
      prompt: lockedSource.prompt ?? current.prompt,
      avatar: lockedSource.avatar ?? current.avatar,
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
      description: "员工配置将被删除；已有会话与历史消息会保留。",
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
    <div className="wand-teams-list wand-employee-list">
      <header className="wand-teams-toolbar">
        <div className="wand-teams-toolbar-search">
          <WandSearchField
            value={query}
            label="搜索员工名字、职责或 Prompt"
            placeholder="搜索员工名字、职责或 Prompt…"
            onValueChange={setQuery}
          />
        </div>
        <div className="wand-teams-toolbar-actions">
          <label className="wand-employee-filter-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            <span>显示归档</span>
          </label>
          <WandButton
            kind="primary"
            disabled={isCreating}
            onClick={() => setIsCreating(true)}
          >
            <WandIcon name="plus" size={14} slot="start" />
            新建员工
          </WandButton>
        </div>
      </header>

      {error ? (
        <div className="wand-team-candidate-error" role="alert">
          {error}
        </div>
      ) : null}
      {mutationError ? <div className="wand-team-candidate-error" role="alert">{mutationError}</div> : null}

      <div className="wand-team-members">
        {isCreating ? (
          <EmployeeCreateForm
            catalog={catalog}
            providerOptions={providerOptions}
            onSave={handleCreate}
            onCancel={() => setIsCreating(false)}
          />
        ) : null}

        {loading && employees.length === 0 ? (
          <p className="wand-teams-empty" role="status">
            正在加载员工列表…
          </p>
        ) : null}

        {!loading && filtered.length === 0 && !isCreating ? (
          <div className="wand-teams-empty">
            <p>
              {query
                ? "没有匹配的员工"
                : "还没有硅基员工。创建一个角色，并为它配置专属的执行工具链吧！"}
            </p>
            {!query ? (
              <WandButton kind="primary" onClick={() => setIsCreating(true)}>
                <WandIcon name="plus" size={14} slot="start" />
                创建你的第一个硅基员工
              </WandButton>
            ) : null}
          </div>
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
      </div>
    </div>
  );
}
