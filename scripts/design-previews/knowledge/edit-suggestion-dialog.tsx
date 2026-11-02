import * as React from "react";
import { Modal } from "antd";
import { WandButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon } from "../../../src/web-ui/react/ui/icons";

export function EditSuggestionDialog({
  open,
  onGoToComments,
  onContinueManualEdit,
  onCancel,
}: {
  open: boolean;
  onGoToComments(): void;
  onContinueManualEdit(): void;
  onCancel(): void;
}) {
  return (
    <Modal
      open={open}
      onCancel={onCancel}
      footer={null}
      centered
      width={460}
      className="edit-suggestion-modal"
      title={
        <div className="suggestion-modal-title">
          <WandIcon name="sparkle" size={18}/>
          <span>建议使用 AI 自动更新</span>
        </div>
      }
    >
      <div className="suggestion-modal-body">
        <p className="suggestion-lead">
          在文档底部的评论区发表修改意见或补充要求（例如：<em>“增加快捷键说明”、“精简开头”</em>），AI 员工即可直接吸收要求并自动更新文档。
        </p>
        <p className="suggestion-sub">
          当然，如果你想完全掌控文字措辞与 Markdown 排版，也可以继续手动编辑。
        </p>

        <div className="suggestion-modal-actions">
          <WandButton
            kind="ghost"
            onClick={onContinueManualEdit}
          >
            继续手动编辑
          </WandButton>
          <WandButton
            kind="primary"
            onClick={onGoToComments}
          >
            <WandIcon name="chat" size={14}/>
            去评论区发表要求
          </WandButton>
        </div>
      </div>
    </Modal>
  );
}
