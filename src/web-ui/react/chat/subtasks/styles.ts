import type { CollapseProps } from "antd";

/** Use Ant's borderless semantic slots, scoped to this inspector only. */
export const SUBTASK_DISCLOSURE_STYLES: CollapseProps["styles"] = {
  root: { borderRadius: 0, background: "transparent" },
  header: { padding: "12px 0", borderRadius: 0 },
  body: { padding: "0 0 12px" },
};

let installed = false;
export function installSubtaskStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.dataset.chatSubtasks = "";
  style.textContent = `
    #chat-output { container-type:inline-size; --chat-subtask-width:38%; }
    .chat-subtasks-host { flex:none; }
    .chat-subtasks-toolbar { height:42px; display:flex; justify-content:flex-end; align-items:center; padding:0 12px; border-bottom:1px solid var(--border-subtle); }
    .chat-subtasks-toolbar[hidden] { display:none; }
    .chat-subtasks-toolbar .chat-subtasks-trigger { width:300px; height:30px; justify-content:flex-start; gap:6px; font-size:12px; }
    .chat-subtasks-counts { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary); }
    #chat-output:has(.chat-subtasks-toolbar:not([hidden])) > .chat-turn-navigation-host { top:50px; }
    #chat-output[data-subtasks-open="true"] > .chat-turn-navigation-host { right:calc(var(--chat-subtask-width) + 12px); }
    /* The viewport already has width:100%; margins alone only create overflow.
       Constrain its actual border box so every message reflows beside details. */
    #chat-output > .chat-messages { transition:width var(--motion-normal) var(--ease-out-expo); }
    #chat-output[data-subtasks-open="true"] > .chat-messages { width:calc(100% - var(--chat-subtask-width)); margin-inline:0; }
    @media (min-width:1280px) {
      html[data-chat-width="column"] #chat-output[data-subtasks-open="true"] > .chat-messages { margin-inline-start:max(0px,calc((100% - var(--chat-subtask-width) - var(--chat-column-width))/2)); }
    }
    .chat-subtasks-panel { position:absolute; z-index:2; inset:42px 0 0 auto; width:var(--chat-subtask-width); box-sizing:border-box; display:flex; flex-direction:column; min-height:0; background:var(--bg-surface); border-left:1px solid var(--border-subtle); transform:translateX(100%); visibility:hidden; transition:transform var(--motion-normal) var(--ease-out-expo),visibility var(--motion-normal); }
    #chat-output[data-subtasks-open="true"] .chat-subtasks-panel { transform:translateX(0); visibility:visible; }
    .chat-subtasks-panel > header { display:flex; flex:none; align-items:center; justify-content:space-between; min-height:52px; box-sizing:border-box; padding:8px 20px; font-size:14px; }
    .chat-subtasks-panel-count { font-size:12px; font-weight:400; color:var(--text-secondary); margin-left:6px; font-variant-numeric:tabular-nums; }
    .chat-subtasks-panel > .ant-collapse { flex:none; padding:0 24px 12px; border-bottom:1px solid var(--border-subtle); }
    .chat-subtasks-list { max-height:180px; overflow:auto; display:flex; flex-direction:column; }
    .chat-subtasks-list .chat-subtasks-item { width:100%; min-height:52px; height:auto; padding:10px 12px; display:flex; text-align:left; justify-content:space-between; white-space:normal; border:0; border-radius:0; box-shadow:none; background:transparent; }
    .chat-subtasks-list .chat-subtasks-item + .chat-subtasks-item { border-top:1px solid var(--border-subtle); }
    .chat-subtasks-item > span { overflow-wrap:anywhere; min-width:0; }
    .chat-subtasks-item-copy { display:flex; flex-direction:column; align-items:flex-start; gap:5px; font-size:13px; }
    .chat-subtasks-item[aria-pressed="true"] { background:var(--bg-active); font-weight:500; }
    .chat-subtasks-item small { font-size:11px; font-weight:400; color:var(--text-secondary); }
    .chat-subtasks-item-check { flex:none; opacity:0; color:var(--accent); }
    .chat-subtasks-item[aria-pressed="true"] .chat-subtasks-item-check { opacity:1; }
    .chat-subtasks-scroll { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; overflow-anchor:none; scrollbar-gutter:stable; padding:24px; }
    .chat-subtasks-scroll[hidden] { display:none; }
    .chat-subtasks-current { display:flex; flex-direction:column; align-items:flex-start; gap:10px; }
    .chat-subtasks-current > strong { font-size:18px; font-weight:600; line-height:1.5; }
    .chat-subtasks-current > span { font-size:11px; color:var(--text-secondary); }
    .chat-subtasks-latest { margin:20px 0; padding:0 0 20px; border-bottom:1px solid var(--border-subtle); font-size:13px; line-height:1.6; color:var(--text-secondary); overflow-wrap:anywhere; }
    .chat-subtask-body { overflow-wrap:anywhere; }
    .chat-subtasks-instruction { white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; line-height:1.7; font-weight:400; }
    .chat-subtasks-empty-result { margin:24px 0; color:var(--text-secondary); font-size:13px; }
    .chat-subtasks-secondary { margin-top:24px; padding-top:12px; border-top:1px solid var(--border-subtle); }
    .chat-subtask-body pre { max-width:100%; overflow:auto; }
    .chat-subtask-link { max-width:100%; text-align:left; }
    @container (max-width:960px) {
      #chat-output[data-subtasks-open="true"] > .chat-messages { width:100%; visibility:hidden; pointer-events:none; }
      #chat-output[data-subtasks-open="true"] > .chat-turn-navigation-host { visibility:hidden; }
      .chat-subtasks-panel { width:100%; border-left:0; }
      .chat-subtasks-toolbar .chat-subtasks-trigger { width:min(300px,100%); }
    }
    @media (prefers-reduced-motion:reduce) {
      #chat-output > .chat-messages, .chat-subtasks-panel { transition:none; }
    }
  `;
  document.head.appendChild(style);
}
