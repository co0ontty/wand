import { useEffect, useRef, useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import {
  composerSkillsController,
  type ComposerSkillsMount,
} from "./controller";

/**
 * Skills 弹层本体。保留 `#composer-skills-popover` 的 id 与 role/aria
 * —— `events.ts` 的「点外部关闭」与 Escape 仍按这个节点判断。
 *
 * 打开时把焦点交给第一个选项（原来是 `refreshClaudeSkillsPicker` 里的
 * `requestAnimationFrame` + focus）。只挂载一次，所以只需在 mount 时做一次。
 */
export function ComposerSkillsPopover({ mount }: { mount: ComposerSkillsMount }): React.ReactElement {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);

  // 打开后把焦点交给第一个选项（旧实现是 refreshClaudeSkillsPicker 里的
  // requestAnimationFrame + focus，每次同步都重做一遍）。这里只在弹层打开
  // 或选项从「加载中」变为就绪时做一次：用户点第二个选项后焦点不应被拉回第一个。
  useEffect(() => {
    (firstOptionRef.current ?? popoverRef.current)?.focus();
  }, [mount.options.length, mount.loading]);

  const heading = mount.selectedCount
    ? `已选 ${mount.selectedCount}`
    : "本条不应用";

  return (
    <div
      className="composer-skills-popover"
      id="composer-skills-popover"
      role="dialog"
      aria-label="选择 skills"
      tabIndex={-1}
      ref={popoverRef}
    >
      <div className="composer-skills-heading">
        <span>Skills</span>
        <span className="composer-skills-count">{heading}</span>
      </div>
      <div className="composer-skills-list">
        {mount.loading ? (
          <div className="composer-skills-empty">正在加载 skills…</div>
        ) : mount.options.length ? (
          mount.options.map((option, index) => (
            <button
              className={`composer-skill-option${option.selected ? " is-selected" : ""}`}
              type="button"
              role="checkbox"
              aria-checked={option.selected}
              data-claude-skill-name={option.name}
              key={option.name}
              ref={index === 0 ? firstOptionRef : undefined}
              onClick={(event) => {
                event.preventDefault();
                mount.onToggle(option.name);
              }}
            >
              <span className="composer-skill-check" aria-hidden="true">{option.selected ? "✓" : ""}</span>
              <span className="composer-skill-copy">
                <span className="composer-skill-name">{option.name}</span>
                {option.description ? (
                  <span className="composer-skill-description">{option.description}</span>
                ) : null}
              </span>
              <span className="composer-skill-source">{option.sourceLabel}</span>
            </button>
          ))
        ) : (
          <div className="composer-skills-empty">当前目录没有可用 skills。</div>
        )}
      </div>
    </div>
  );
}

export function ComposerSkillsHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(
    composerSkillsController.subscribe,
    composerSkillsController.getSnapshot,
    composerSkillsController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <ComposerSkillsPopover mount={mount} />,
    mount.target,
    mount.key,
  ));
}
