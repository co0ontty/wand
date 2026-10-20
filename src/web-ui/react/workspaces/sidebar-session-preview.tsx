import * as React from "react";
import { Badge, Tooltip } from "antd";
import { agentToolDisplayName } from "../../provider-identity";
import { installStyleSheet } from "../styles";
import { WandChip } from "../ui/chip";
import { WandIcon } from "../ui/icons";
import { WandUiBoundary } from "../theme";
import { SessionProviderMark } from "./session-mark";
import { sidebarSessionLabel, workspaceSessionProvider } from "./session-order";
import { sidebarGlowColor, sidebarSessionState, sessionGlowStatus } from "./sidebar-session-state";
import { fitSidebarSessionPreview, type SidebarPreviewLayout } from "./sidebar-session-preview-layout";
import type { WorkspaceSessionSummary } from "./types";

const previewStyles = String.raw`
.sidebar-session-preview { display:grid; grid-template-rows:1fr; opacity:1; min-width:0; transition:grid-template-rows var(--motion-normal) var(--ease-out-expo),opacity var(--motion-fast) var(--ease-in-out-smooth); }
.sidebar-session-preview[data-expanded="true"] { grid-template-rows:0fr; opacity:0; }
.sidebar-session-preview-clip { min-height:0; min-width:0; overflow:hidden; }
.sidebar-session-preview-row { display:flex; align-items:center; gap:4px; min-width:0; padding:2px 4px 6px; overflow:hidden; }
.sidebar-session-preview .sidebar-session-tag.ant-btn { flex:none; width:36px; min-width:36px; height:28px; padding:0; gap:4px; border-radius:var(--radius-xs); color:var(--text-secondary); background:var(--sidebar-surface,var(--bg-surface)); border:1px solid var(--border-subtle); }
.sidebar-session-preview .sidebar-session-tag[data-titles="true"] { width:auto; padding-inline:6px; }
.sidebar-session-preview .sidebar-session-tag[aria-pressed="true"], .sidebar-session-preview .sidebar-session-more.ant-btn[data-contains-current="true"] { background:var(--sidebar-selected,var(--bg-active)); color:var(--sidebar-accent,var(--text-link)); border-color:var(--sidebar-selected,var(--border-subtle)); }
.sidebar-session-preview :is(.sidebar-session-tag,.sidebar-session-more):focus-visible { outline:2px solid var(--sidebar-accent,var(--border-focus)); outline-offset:-2px; }
.sidebar-session-preview .sidebar-session-more.ant-btn { flex:none; width:auto; min-width:0; max-width:100%; height:28px; padding:0 6px; font-size:11px; font-variant-numeric:tabular-nums; border-radius:var(--radius-xs); color:var(--text-secondary); background:var(--sidebar-surface,var(--bg-surface)); border:1px solid var(--border-subtle); }
.sidebar-session-tag-content { display:inline-flex; align-items:center; gap:4px; }
.sidebar-session-tag-title { font-size:11px; line-height:16px; white-space:nowrap; }
.sidebar-session-preview .sidebar-provider-mark { flex:none; }
.sidebar-session-preview .sidebar-provider-mark > svg { width:100%; height:100%; }
.sidebar-session-preview-status { display:inline-flex; align-items:center; justify-content:center; width:8px; height:8px; flex:none; line-height:0; }
.sidebar-session-preview-status .ant-badge { line-height:0; }
.sidebar-session-preview-status .ant-badge-status-dot { width:5px; height:5px; }
.sidebar-session-preview-measure-clip { position:absolute; width:0; height:0; overflow:hidden; visibility:hidden; pointer-events:none; }
.sidebar-session-preview-measure { display:flex; width:max-content; gap:4px; }
.sidebar-session-preview-measure-clip .sidebar-session-more.ant-btn { max-width:none; }
.sidebar-session-preview-task { margin-inline-start:20px; }
.sidebar-session-preview-person { margin-inline-start:28px; }
@media (pointer:coarse) { .sidebar-session-preview :is(.sidebar-session-tag,.sidebar-session-more).ant-btn { height:36px; } }
@media (prefers-reduced-motion:reduce) { .sidebar-session-preview { transition:none; } }
`;

export interface SidebarSessionPreviewProps {
  sessions: readonly WorkspaceSessionSummary[];
  expanded: boolean;
  selectedSessionId?: string | null;
  liveTitles?: Readonly<Record<string, string>>;
  label: string;
  className?: string;
  disabled?: boolean;
  expansionRef?: React.RefObject<HTMLElement | null>;
  onActivate(session: WorkspaceSessionSummary): void;
  /** Open the complete matching list without selecting a hidden session. */
  onExpand?(): void;
}

function PreviewStatus({ session }: { session: WorkspaceSessionSummary }): React.ReactElement {
  const glow = sessionGlowStatus(session);
  const color = sidebarGlowColor(glow) ?? "var(--text-tertiary)";
  return <span className="sidebar-session-preview-status" style={{ color }} aria-hidden="true">
    {glow === "just-completed" ? <WandIcon name="check" size={8}/> : <Badge color={color}/>}
  </span>;
}

/** Real controls decide optional titles and overflow; no viewport/count threshold or horizontal carousel. */
export function SidebarSessionPreview({ sessions, expanded, selectedSessionId, liveTitles, label,
  className = "", disabled = false, expansionRef, onActivate, onExpand }: SidebarSessionPreviewProps): React.ReactElement | null {
  const row = React.useRef<HTMLDivElement>(null);
  const measure = React.useRef<HTMLDivElement>(null);
  const iconProbe = React.useRef<HTMLButtonElement>(null);
  const moreProbe = React.useRef<HTMLButtonElement>(null);
  const moreText = React.useRef<HTMLSpanElement>(null);
  // Do not mount every session before the first measurement. A collapsed person
  // can own thousands of sessions while only a handful of preview chips fit.
  const [layout, setLayout] = React.useState<SidebarPreviewLayout>({ titles: false, count: 0 });
  const [measureTitles, setMeasureTitles] = React.useState(false);
  const [dismissedTooltipId, setDismissedTooltipId] = React.useState<string | null>(null);
  const labels = sessions.map((session, index) => sidebarSessionLabel(session, index, liveTitles?.[session.id]));
  const signature = JSON.stringify(sessions.map((session, index) => [session.id, labels[index]]));
  React.useLayoutEffect(() => { installStyleSheet("wand-sidebar-session-preview", previewStyles); }, []);
  React.useLayoutEffect(() => {
    const element = row.current;
    const probe = measure.current;
    if (!element || !probe || !iconProbe.current || !moreProbe.current || !moreText.current) return;
    let active = true;
    const recalculate = (): void => {
      if (!active) return;
      const css = getComputedStyle(element);
      const gap = Number.parseFloat(css.columnGap) || 0;
      const padding = (Number.parseFloat(css.paddingInlineStart) || 0) + (Number.parseFloat(css.paddingInlineEnd) || 0);
      const available = element.clientWidth - padding;
      const iconWidth = iconProbe.current!.getBoundingClientRect().width;
      // A title chip is always wider than its icon-only chip. If even all icons
      // cannot fit, full-title probes cannot change the result: never mount them.
      const canFitIcons = iconWidth > 0 && iconWidth * sessions.length + gap * (sessions.length - 1) <= available;
      setMeasureTitles(previous => previous === canFitIcons ? previous : canFitIcons);
      const titleWidths = canFitIcons && probe.children.length === sessions.length
        ? Array.from(probe.children).map(child => child.getBoundingClientRect().width)
        : Array<number>(sessions.length).fill(0);
      const next = fitSidebarSessionPreview(available, titleWidths,
        iconWidth, gap, hidden => {
          // Measure the actual +N text (including digit changes), not a guessed reserved width.
          moreText.current!.textContent = `+${hidden}`;
          return moreProbe.current!.getBoundingClientRect().width;
        });
      setLayout(previous => previous.titles === next.titles && previous.count === next.count ? previous : next);
    };
    recalculate();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(recalculate);
    observer?.observe(element); observer?.observe(probe);
    window.addEventListener("resize", recalculate);
    document.fonts?.ready.then(recalculate);
    document.fonts?.addEventListener("loadingdone", recalculate);
    return () => {
      active = false; observer?.disconnect(); window.removeEventListener("resize", recalculate);
      document.fonts?.removeEventListener("loadingdone", recalculate);
    };
  }, [signature, measureTitles]);
  if (!sessions.length) return null;
  const shown = sessions.slice(0, layout.count);
  const hidden = sessions.length - shown.length;
  const containsCurrent = sessions.slice(shown.length).some(session => session.id === selectedSessionId);
  // Ant wraps fragments in a plain span; own the content row so block SVGs cannot stack below the status.
  const contents = (session: WorkspaceSessionSummary, index: number, full: boolean): React.ReactNode => <span className="sidebar-session-tag-content">
    <PreviewStatus session={session}/><SessionProviderMark session={session} size={14}/>
    {full ? <span className="sidebar-session-tag-title">{labels[index]}</span> : null}
  </span>;
  const focusOwner = (): void => { expansionRef?.current?.focus({ preventScroll: true }); };
  const moreDescription = `还有 ${hidden} 个匹配会话${containsCurrent ? "，包含当前会话" : ""}，展开完整列表`;
  return <WandUiBoundary><div className={`sidebar-session-preview ${className}`} data-expanded={expanded}
    inert={expanded || disabled} aria-hidden={expanded || undefined}>
    <div className="sidebar-session-preview-clip"><div ref={row} className="sidebar-session-preview-row"
      data-title-mode={layout.titles ? "full" : "icons"} data-total-count={sessions.length} data-visible-count={shown.length}
      role="group" aria-label={label}>
      {shown.map((session, index) => {
        const state = sidebarSessionState(session);
        const provider = workspaceSessionProvider(session);
        const tool = provider ? agentToolDisplayName(provider, session.engine) : "终端";
        const description = `${labels[index]} · ${tool} · ${state.label}`;
        return <Tooltip key={session.id} title={description} open={expanded || dismissedTooltipId === session.id ? false : undefined}>
          <WandChip size="sm" kind="ghost" className="sidebar-session-tag" data-preview-session-id={session.id}
            data-titles={layout.titles} aria-label={description} aria-pressed={session.id === selectedSessionId}
            disabled={disabled} onMouseEnter={() => setDismissedTooltipId(current => current === session.id ? null : current)}
            onFocus={() => setDismissedTooltipId(current => current === session.id ? null : current)}
            onClick={event => {
              // The tag stays visible after navigation; dismiss its tooltip so it cannot cover the parent row.
              setDismissedTooltipId(session.id);
              // Session navigation and parent disclosure are separate actions.
              event.stopPropagation(); onActivate(session);
            }}>{contents(session, index, layout.titles)}</WandChip>
        </Tooltip>;
      })}
      {hidden > 0 ? <Tooltip title={moreDescription} open={expanded ? false : undefined}>
        <WandChip size="sm" kind="ghost" className="sidebar-session-more" data-hidden-count={hidden} data-contains-current={containsCurrent}
          aria-label={moreDescription} aria-expanded={expanded} aria-controls={expansionRef?.current?.getAttribute("aria-controls") ?? undefined}
          disabled={disabled || !onExpand} onClick={event => {
            event.stopPropagation(); focusOwner(); onExpand?.();
          }}>+{hidden}</WandChip>
      </Tooltip> : null}
      <div className="sidebar-session-preview-measure-clip" aria-hidden="true" inert>
        <div ref={measure} className="sidebar-session-preview-measure">
          {measureTitles ? sessions.map((session, index) => <WandChip key={session.id} size="sm" kind="ghost" tabIndex={-1}
            className="sidebar-session-tag" data-titles="true">{contents(session, index, true)}</WandChip>) : null}
        </div>
        <WandChip ref={iconProbe} size="sm" kind="ghost" tabIndex={-1} className="sidebar-session-tag">{contents(sessions[0], 0, false)}</WandChip>
        <WandChip ref={moreProbe} size="sm" kind="ghost" tabIndex={-1} className="sidebar-session-more"><span ref={moreText}>+{sessions.length}</span></WandChip>
      </div>
    </div></div>
  </div></WandUiBoundary>;
}
