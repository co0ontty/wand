import * as React from "react";
import { Button, Typography } from "antd";
import type { QuickCommitAction } from "./types";

const styles = `
.wand-git-dock{display:grid;grid-template-columns:minmax(0,1fr) 76px;gap:8px;min-height:188px}
.wand-git-bubbles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:center;justify-items:center;gap:12px;padding:12px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg-secondary);position:relative}
.wand-git-bubble.ant-btn{max-width:100%;height:40px;padding-inline:12px;touch-action:none;user-select:none;transition:transform var(--motion-normal) var(--ease-out-expo),background var(--motion-fast) var(--ease-out-expo)}
.wand-git-bubble[data-dragging=true]{transition:none;z-index:2}
.wand-git-bubble[data-member=true]{border-color:var(--accent);background:var(--bg-secondary)}
.wand-git-bubble-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex-shrink:0}
.wand-git-bubble[data-bubble=tag] .wand-git-bubble-dot{background:var(--info)}
.wand-git-bubble[data-bubble=push] .wand-git-bubble-dot{background:var(--success)}
.wand-git-launch.ant-btn{height:100%;white-space:normal;min-height:188px}
.wand-git-launch[data-hot=true]{border-color:var(--accent);color:var(--accent)}
@media(prefers-reduced-motion:reduce){.wand-git-bubble.ant-btn{transition:none}}
`;

type Bubble = "commit" | "tag" | "push" | "sub" | "worktree";
const labels: Record<Bubble, string> = { commit: "Commit", tag: "Tag", push: "Push", sub: "Sub", worktree: "Worktree" };

export function composeGitBubbles(members: readonly string[]): QuickCommitAction {
  return members.includes("tag") ? (members.includes("push") ? "commit-tag-push" : "commit-tag")
    : members.includes("push") ? "commit-push" : "commit";
}

export function MagneticGitDock(props: {
  hasChanges: boolean; hasSubmodule: boolean; worktreeCount: number; ahead: number;
  busy: boolean; feedback: string;
  onAction(action: QuickCommitAction, submodule: boolean): void;
  onWorktree(): void;
  onPush(): void;
}) {
  const launch = React.useRef<HTMLButtonElement>(null);
  const buttons = React.useRef(new Map<Bubble, HTMLElement>());
  const drag = React.useRef<{ id: Bubble; x: number; y: number; members: Bubble[]; moved: boolean } | null>(null);
  const suppressClick = React.useRef(false);
  const [visual, setVisual] = React.useState<{ members: Bubble[]; x: number; y: number; hot: boolean } | null>(null);
  const ids: Bubble[] = ["commit", "tag", "push", ...(props.hasSubmodule ? ["sub" as const] : []), "worktree"];
  const enabled = (id: Bubble) => !props.busy && (id === "worktree" ? props.worktreeCount > 0
    : id === "push" ? props.hasChanges || props.ahead > 0 : props.hasChanges);
  function execute(members: Bubble[]) {
    if (members.includes("worktree")) props.onWorktree();
    else if (!props.hasChanges && members.includes("push")) props.onPush();
    else props.onAction(composeGitBubbles(members), members.includes("sub"));
  }
  function finish(event: React.PointerEvent<HTMLElement>, cancelled = false) {
    const current = drag.current;
    if (!current) return;
    suppressClick.current = current.moved;
    const box = launch.current?.getBoundingClientRect();
    const hot = !!box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (current.moved && hot && !cancelled) execute(current.members);
    drag.current = null;
    setVisual(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <>
    <style>{styles}</style>
    <div className="wand-git-dock" aria-label="Git 气泡操作" aria-busy={props.busy}>
      <div className="wand-git-bubbles">
        {ids.map((id) => <Button key={id} shape="round" className="wand-git-bubble" data-bubble={id}
          ref={(node) => { if (node) buttons.current.set(id, node); else buttons.current.delete(id); }}
          disabled={!enabled(id)} data-member={visual?.members.includes(id) || false}
          data-dragging={visual?.members.includes(id) || false}
          title={id === "worktree" ? `合并全部 ${props.worktreeCount} 个 Worktree 到当前分支并推送` : undefined}
          aria-label={id === "worktree" ? "合并全部 Worktree 并推送" : `${labels[id]} 气泡`}
          style={visual?.members.includes(id) ? { transform: `translate(${visual.x}px, ${visual.y}px)` } : undefined}
          onPointerDown={(event) => {
            if (event.button !== 0 || !enabled(id)) return;
            suppressClick.current = false;
            drag.current = { id, x: event.clientX, y: event.clientY, members: [id], moved: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.id !== id) return;
            const x = event.clientX - current.x;
            const y = event.clientY - current.y;
            if (Math.hypot(x, y) > 6) current.moved = true;
            if (!current.moved) return;
            if (id !== "worktree" && props.hasChanges) {
              for (const candidate of ["commit", "tag", "push"] as Bubble[]) {
                if (current.members.includes(candidate)) continue;
                const box = buttons.current.get(candidate)?.getBoundingClientRect();
                if (box && Math.hypot(event.clientX - (box.x + box.width / 2), event.clientY - (box.y + box.height / 2)) < 40) {
                  current.members.push(candidate);
                }
              }
            }
            const box = launch.current?.getBoundingClientRect();
            const hot = !!box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
            setVisual({ members: [...current.members], x, y, hot });
          }}
          onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
          onLostPointerCapture={() => { drag.current = null; setVisual(null); }}
          onClick={(event) => { if (suppressClick.current && event.detail > 0) { suppressClick.current = false; return; } suppressClick.current = false; execute([id]); }}>
          <span className="wand-git-bubble-dot"/>{labels[id]}{id === "worktree" && props.worktreeCount > 0 ? ` ${props.worktreeCount}` : ""}
        </Button>)}
      </div>
      <Button ref={launch} className="wand-git-launch" data-hot={visual?.hot || false}
        disabled={props.busy || !props.hasChanges} onClick={() => props.onAction("commit", false)} aria-live="polite">
        {props.feedback || (visual?.hot ? "松手执行" : "提交 →")}
      </Button>
    </div>
    <Typography.Text type="secondary">点按直接执行，拖动气泡组合后放入提交区。Worktree：合并全部工作树到当前分支后推送。</Typography.Text>
  </>;
}
