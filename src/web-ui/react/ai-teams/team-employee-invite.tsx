import * as React from "react";
import type { SiliconEmployee } from "../../../ai-team-types.js";
import { WandButton, WandIcon, WandSelect } from "../ui";
import { employeeJoinError, type TeamMemberDraft } from "./team-employee-binding.js";

export function TeamEmployeeInvite({
  employees, loading, error, reload, members, replacingIndex = -1, disabled, onPick,
}: {
  employees: readonly SiliconEmployee[];
  loading: boolean;
  error: string | null;
  reload(): void;
  members: readonly TeamMemberDraft[];
  replacingIndex?: number;
  disabled: boolean;
  onPick(employee: SiliconEmployee): void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const inviteButtonRef = React.useRef<HTMLButtonElement>(null);
  const selectTriggerRef = React.useRef<HTMLButtonElement>(null);
  const menuClass = "wand-team-employee-menu-" + React.useId();
  const replacing = replacingIndex >= 0;
  React.useEffect(() => {
    if (open && !loading && !error) selectTriggerRef.current?.focus();
  }, [open, loading, error]);
  React.useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent): void => {
      if (rowRef.current?.contains(event.target as Node)) return;
      // Only this selector's portalled popup belongs to the invitation form.
      if (event.target instanceof Element
        && event.target.closest(".wand-ui-select-content")?.classList.contains(menuClass)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [open, menuClass]);
  return <div ref={rowRef} className="wand-team-employee-invite" onKeyDown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.stopPropagation();
    setOpen(false);
    inviteButtonRef.current?.focus();
  }}>
    <WandButton ref={inviteButtonRef} kind="ghost" size="small" className="task-board-create-button"
      aria-pressed={open} disabled={disabled} onClick={() => setOpen((value) => !value)}>
      <WandIcon name="plus" slot="start" className="wand-teams-create-icon"/>
      {replacing ? "从通讯录选择 / 替换" : "从通讯录邀请"}
    </WandButton>
    <div className="wand-team-candidate-slot" data-collapsed={!open || undefined}>
      <div className="wand-team-employee-invite-inner" inert={!open}>
        <div className="wand-team-candidates">
          <small className="wand-new-session-field-hint">员工在私聊与团队中使用自己的知识库，不共享私聊历史或其他员工知识。基础角色与 CLI 候选由员工资料决定；团队只配置分工。</small>
          {error ? <div role="alert" className="wand-new-session-error">
            通讯录加载失败：{error}
            <WandButton kind="ghost" size="small" disabled={loading || disabled} onClick={reload}>重试通讯录</WandButton>
          </div> : loading ? <p role="status">正在加载通讯录…</p> : <WandSelect
            ariaLabel={replacing ? "绑定团队员工" : "邀请团队员工"}
            triggerRef={selectTriggerRef}
            contentClassName={menuClass}
            className="wand-settings-input"
            searchable searchPlaceholder="搜索员工" placeholder="选择员工"
            disabled={disabled}
            options={employees.map((employee) => {
              const reason = employeeJoinError(employee, members, replacingIndex);
              return { value: employee.id, label: `${employee.name} · ${reason || employee.duty || "硅基员工"}`,
                disabled: !!reason };
            })}
            onValueChange={(id) => {
              const employee = employees.find((entry) => entry.id === id);
              if (!employee || employeeJoinError(employee, members, replacingIndex)) return;
              onPick(employee);
              setOpen(false);
              requestAnimationFrame(() => inviteButtonRef.current?.focus());
            }}
          />}
          {!error && !loading && employees.length === 0 ? <p>通讯录中还没有员工，可继续添加手工 CLI 成员。</p> : null}
        </div>
      </div>
    </div>
  </div>;
}
