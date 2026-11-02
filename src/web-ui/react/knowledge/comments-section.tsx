import * as React from "react";
import { Popover, Tooltip } from "antd";
import { WandButton, WandIconButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { ProviderLogo } from "../provider-logo";
import { EmployeeAvatar } from "../agents/employee-avatar";
import {
  DEFAULT_EMPLOYEES_CONFIG,
  MentionCapsule,
  createDefaultMention,
  type MentionTarget,
} from "./mention-strip";
import type { KnowledgeComment } from "../../../knowledge-types.js";

export function CommentsSection({
  comments,
  canAutoUpdate,
  inputRef,
  employees = DEFAULT_EMPLOYEES_CONFIG,
  onAddComment,
  onDeleteComment,
}: {
  comments: KnowledgeComment[];
  canAutoUpdate: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  employees?: Array<{ id: string; name: string; avatar?: string }>;
  onAddComment(text: string, mention?: MentionTarget): void;
  onDeleteComment(id: string): void;
}) {
  const [draft, setDraft] = React.useState("");
  const [mention, setMention] = React.useState<MentionTarget | null>(null);
  const [atPickerOpen, setAtPickerOpen] = React.useState(false);
  const internalInputRef = React.useRef<HTMLTextAreaElement | null>(null);

  const pendingCount = comments.filter(c => !c.applied).length;

  const handleSubmit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAddComment(trimmed, mention || undefined);
    setDraft("");
    setMention(null);
  };

  const handleSelectEmployee = (empId: string) => {
    const emp = employees.find(e => e.id === empId);
    setMention(createDefaultMention(empId, emp?.name, emp?.avatar));
    setAtPickerOpen(false);
    setTimeout(() => {
      (inputRef?.current ?? internalInputRef.current)?.focus();
    }, 40);
  };

  return (
    <section className="document-comments" aria-label="文档评论与下次生成要求">
      <div className="comments-header">
        <div className="comments-title-group">
          <div className="comments-title-row">
            <h3>评论与生成要求</h3>
            <span className="comments-count-pill">
              {comments.length} 条评论{pendingCount > 0 ? ` · ${pendingCount} 条待下次生成吸收` : ""}
            </span>
          </div>
          <p className="comments-desc">
            在此发表的意见、补充与要求，将在下次自动更新或重新生成时，作为 Prompt 约束直接提供给负责生成的 Agent；支持在输入框内 @ 指定员工并直接配置工具链。
          </p>
        </div>
      </div>

      {comments.length > 0 && (
        <div className="comment-list" role="feed" aria-label="评论列表">
          {comments.map((comment) => (
            <article
              key={comment.id}
              className={`comment-item ${comment.applied ? "applied" : "pending"}`}
              aria-label={`${comment.author} 的评论`}
            >
              <div className="comment-item-top">
                <div className="comment-author-info">
                  <span className="comment-avatar">{comment.author[0]}</span>
                  <span className="comment-author">{comment.author}</span>
                  <span className="comment-time">{comment.timestamp}</span>
                </div>
                <div className="comment-item-actions">
                  <span className={`comment-badge ${comment.applied ? "applied" : "pending"}`}>
                    <WandIcon name={comment.applied ? "check" : "sparkle"} size={11}/>
                    {comment.applied ? "已在当前版本采用" : "待下次生成采用"}
                  </span>
                  <Tooltip title="删除此条要求">
                    <WandIconButton
                      aria-label="删除评论"
                      size="small"
                      onClick={() => onDeleteComment(comment.id)}
                    >
                      <WandIcon name="trash" size={13}/>
                    </WandIconButton>
                  </Tooltip>
                </div>
              </div>

              {comment.mention && (
                <div className="comment-applied-mention">
                  <span className="mention-badge-emp">
                    <EmployeeAvatar
                      employee={{ id: comment.mention.employeeId, name: comment.mention.employeeName, avatar: comment.mention.avatar }}
                      size="toolbar"
                      renderMode="static"
                    />
                    @{comment.mention.employeeName}
                  </span>
                  <span className="mention-badge-cli">
                    <ProviderLogo provider={comment.mention.provider} className="comment-mini-logo"/>
                    {comment.mention.provider}
                  </span>
                  <span className="mention-badge-model">
                    <WandIcon name="cpu" size={11}/>
                    {comment.mention.model}
                  </span>
                  <span className="mention-badge-think">
                    <WandIcon name="brain" size={11}/>
                    思考:{comment.mention.thinkingEffort}
                  </span>
                </div>
              )}

              <p className="comment-text">{comment.text}</p>
            </article>
          ))}
        </div>
      )}

      {/* 评论输入框区：单一文本框实体，胶囊作为文本的一部分显示在内部 */}
      <div className="comment-composer">
        <div
          className={`composer-input-surface ${mention ? "has-mention" : ""}`}
          onClick={() => (inputRef?.current ?? internalInputRef.current)?.focus()}
        >
          {/* 当 @ 了员工后，在文本框内部作为内联胶囊显示，不脱离文本框 */}
          {mention && (
            <MentionCapsule
              mention={mention}
              employees={employees}
              onChange={setMention}
              onRemove={() => {
                setMention(null);
                setTimeout(() => (inputRef?.current ?? internalInputRef.current)?.focus(), 30);
              }}
            />
          )}

          <textarea
            ref={node => {
              internalInputRef.current = node;
              if (inputRef && "current" in inputRef) (inputRef as any).current = node;
            }}
            value={draft}
            className="composer-inline-textarea"
            onChange={e => {
              const val = e.target.value;
              setDraft(val);
              if (val.endsWith("@") && !mention) {
                setAtPickerOpen(true);
              }
            }}
            onInput={e => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.max(26, el.scrollHeight)}px`;
            }}
            placeholder={mention ? "输入让该员工处理的具体要求…" : "写下对本文档的修改意见或生成要求（可输入 @ 指派员工，或点击下方 @ 按钮）…"}
            rows={mention ? 1 : 2}
            aria-label="输入评论或生成要求"
            onKeyDown={e => {
              if (e.key === "Backspace" && !draft && mention) {
                setMention(null);
                return;
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </div>

        <div className="comment-composer-bottom">
          <div className="composer-tools-left">
            {/* @ 员工按钮 */}
            <Popover
              open={atPickerOpen}
              onOpenChange={setAtPickerOpen}
              trigger="click"
              arrow={false}
              placement="topLeft"
              content={
                <div className="strip-popover-menu">
                  <div className="popover-title">选择负责处理的员工</div>
                  <div className="popover-options">
                    {employees.map(emp => (
                      <button
                        key={emp.id}
                        className="strip-option-item"
                        onClick={() => handleSelectEmployee(emp.id)}
                      >
                        <EmployeeAvatar employee={{ id: emp.id, name: emp.name, avatar: emp.avatar }} size="toolbar" renderMode="static"/>
                        <div className="opt-user-meta">
                          <span className="opt-name">{emp.name}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              }
            >
              <WandButton
                size="small"
                kind="ghost"
                className={`mention-at-btn ${mention ? "active" : ""}`}
                onClick={e => {
                  e.stopPropagation();
                  setAtPickerOpen(true);
                }}
              >
                <WandIcon name="user" size={13}/>
                {mention ? `已指派 @${mention.employeeName}` : "@ 指派员工处理"}
              </WandButton>
            </Popover>

            <span className="comment-composer-hint">
              <WandIcon name="sparkle" size={13}/>
              {canAutoUpdate
                ? "发表后，点击右上角「自动更新」即可直接指派 Agent 生成新版本"
                : "将作为后续 AI 维护与起草该文档的明确提示词约束"}
            </span>
          </div>

          <WandButton
            size="small"
            kind="primary"
            className="comment-submit-btn"
            disabled={!draft.trim() && !mention}
            onClick={handleSubmit}
          >
            <WandIcon name="chat" size={13}/>发表要求
          </WandButton>
        </div>
      </div>
    </section>
  );
}
