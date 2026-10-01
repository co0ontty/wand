import * as React from "react";
import { WandIcon, WandButton } from "../ui/index.js";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { taskBoardController } from "../issues/task-board-controller.js";
import type { SiliconEmployee } from "../../../ai-team-types.js";
import type { UiSessionVm } from "./ui-store.js";
import { issueAgentProviderModelLine, type IssueModelCatalog } from "../issues/task-board-agent.js";
import { taskBoardRepository } from "../issues/task-board-repository.js";
import { normalizeIssueModelCatalog } from "../issues/task-board-agent.js";
import { subscribeWandModelCatalog } from "../model-catalog.js";

export function ObjectProfilePanel({
  open,
  employee,
  employeeSnapshot,
  selectedSession,
  triggerRef,
  onClose,
}: {
  open: boolean;
  employee?: SiliconEmployee | null;
  employeeSnapshot?: { id: string; name: string; avatar?: string } | null;
  selectedSession?: UiSessionVm | null;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
}): React.ReactElement {
  const [catalog, setCatalog] = React.useState<IssueModelCatalog | null>(null);
  const panelRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    void taskBoardRepository.models()
      .then((payload) => setCatalog(normalizeIssueModelCatalog(payload)))
      .catch(() => setCatalog(null));
    return subscribeWandModelCatalog(setCatalog);
  }, []);

  // 资料浮层的外点关闭在桌面也生效；遮罩只在窄屏可见。
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, onClose, triggerRef]);

  if (!open) return <div id="object-profile-panel" className="object-profile-panel" aria-hidden="true" />;

  const identity = employee || employeeSnapshot;
  const isEmployee = Boolean(identity);
  const title = identity ? identity.name : (selectedSession?.title || "会话信息");

  return (
    <>
      <div
        className="file-panel-backdrop open"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        id="object-profile-panel"
        className="file-side-panel object-profile-panel open"
        aria-label="对象资料面板"
        role="complementary"
      >
        <div className="file-side-panel-header">
          <div className="file-side-panel-title-group">
            <span className="file-side-panel-title">{isEmployee ? "员工资料" : "会话详情"}</span>
          </div>
          <button
            type="button"
            className="file-side-panel-close"
            title="关闭资料面板"
            aria-label="关闭资料面板"
            onClick={onClose}
          >
            <WandIcon name="close" size={16} />
          </button>
        </div>

        <div className="object-profile-body">
          {/* 头像 + 核心名片 */}
          <div className="object-profile-card">
            {identity ? (
              <EmployeeAvatar employee={identity} provider={selectedSession?.provider} size="xl" />
            ) : (
              <div className="object-profile-cli-avatar">
                <WandIcon name="terminal" size={32} />
              </div>
            )}
            <h2 className="object-profile-name">{title}</h2>
            {employee?.duty ? <p className="object-profile-duty">{employee.duty}</p> : null}
            {!employee && employeeSnapshot ? <p className="object-profile-duty">配置已归档或删除，历史对话仍可查看。</p> : null}
          </div>

          {/* 角色 Prompt 全文 */}
          {employee?.prompt ? (
            <section className="object-profile-section">
              <h3 className="object-profile-section-title">角色设定 (Prompt)</h3>
              <div className="object-profile-prompt-content">{employee.prompt}</div>
            </section>
          ) : null}

          {/* 候选工具链有序列表 */}
          {employee?.agents && employee.agents.length > 0 ? (
            <section className="object-profile-section">
              <h3 className="object-profile-section-title">候选工具链</h3>
              <ol className="object-profile-agent-list">
                {employee.agents.map((ag, idx) => (
                  <li key={idx} className="object-profile-agent-item">
                    <span className="object-profile-agent-rank">{idx === 0 ? "首选" : `备用 ${idx + 1}`}</span>
                    <span className="object-profile-agent-name">{issueAgentProviderModelLine(ag, catalog)}</span>
                    {idx === 0 ? <span className="object-profile-agent-badge">首选</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {/* 会话详情兜底展示 */}
          {!identity && selectedSession ? (
            <section className="object-profile-section">
              <h3 className="object-profile-section-title">会话属性</h3>
              <div className="object-profile-meta-grid">
                <div><span>CLI:</span> <strong>{selectedSession.provider || "未知"}</strong></div>
                <div><span>目录:</span> <code>{selectedSession.cwd || "当前工作区"}</code></div>
                <div><span>状态:</span> <strong>{selectedSession.status || "空闲"}</strong></div>
              </div>
            </section>
          ) : null}

          {/* 操作入口 */}
          <div className="object-profile-actions">
            {employee ? (
              <WandButton
                kind="primary"
                onClick={() => {
                  onClose();
                  taskBoardController.open("", "", "teams");
                }}
              >
                编辑员工配置
              </WandButton>
            ) : null}
            <WandButton kind="ghost" onClick={onClose}>
              收起面板
            </WandButton>
          </div>
        </div>
      </aside>
    </>
  );
}
