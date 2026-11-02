let installed = false;
export function installTurnNavStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.dataset.turnNavigation = "";
  style.textContent = `
    .chat-turn-navigation-host { position:absolute; inset:50% auto auto 4px; transform:translateY(-50%); z-index:1; pointer-events:none; }
    .conversation-stream > .turn-nav-dock { position:sticky; top:30%; height:0; z-index:1; align-self:flex-start; }
    #chat-output:has(.turn-nav-rail) > .chat-messages { padding-inline-start:48px; }
    .conversation-stream:has(> .turn-nav-dock) { padding-inline-start:44px; }
    .turn-nav-dock { pointer-events:none; }
    .turn-nav-rail { display:flex; flex-direction:column; max-height:min(40vh,280px); overflow:auto; pointer-events:auto; width:36px; }
    .turn-nav-tick { border:0; background:transparent; padding:5px 6px; min-height:12px; flex:1 0 12px; display:flex; align-items:center; justify-content:flex-start; cursor:pointer; color:var(--text-secondary); }
    .turn-nav-tick > span { display:block; height:2px; width:8px; background:currentColor; opacity:.55; border-radius:2px; }
    .turn-nav-tick[aria-current] > span { width:24px; opacity:1; color:var(--text-primary); }
    .turn-nav-tick:hover > span, .turn-nav-tick:focus-visible > span { width:20px; opacity:1; }
    .turn-nav-tick:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
    .turn-nav-summary { display:flex; flex-direction:column; gap:6px; width:min(300px,calc(100vw - 88px)); padding:4px; border:0; background:transparent; color:var(--text-primary); text-align:start; cursor:pointer; font:inherit; }
    .turn-nav-summary:hover { background:var(--bg-hover); }
    .turn-nav-summary:focus-visible { outline:2px solid var(--accent); }
    .turn-nav-question { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
    .turn-nav-answer { color:var(--text-secondary); display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; overflow-wrap:anywhere; white-space:pre-line; }
    .turn-nav-hint { color:var(--text-secondary); font-size:11px; }
    @media (pointer:coarse) { .turn-nav-tick { min-height:28px; padding-block:10px; } .turn-nav-rail { width:44px; } }

  `;
  document.head.appendChild(style);
}
