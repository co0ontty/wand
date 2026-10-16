let installed = false;
export function installTurnNavStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.dataset.turnNavigation = "";
  style.textContent = `
    .chat-turn-navigation-host { position:absolute; inset:8px 12px auto auto; z-index:1; pointer-events:none; }
    .conversation-stream > .turn-nav-dock { position:sticky; top:8px; height:0; z-index:1; align-self:flex-end; }
    .turn-nav-dock { display:flex; justify-content:flex-end; align-items:center; gap:8px; pointer-events:none; }
    .turn-nav-dock .turn-nav-trigger { pointer-events:auto; }
    .turn-nav-reading { font-size:12px; color:var(--text-secondary); white-space:nowrap; }
    .turn-nav-trigger { font-size:12px; color:var(--text-secondary); }
    .turn-nav-directory { width:min(320px,calc(100vw - 48px)); display:flex; flex-direction:column; gap:8px; }
    .turn-nav-range { font-size:12px; }
    .turn-nav-list { list-style:none; margin:0; padding:0; max-height:min(55vh,420px); overflow:auto; }
    .turn-nav-list .turn-nav-entry { width:100%; height:auto; min-height:44px; padding:8px; display:flex; align-items:baseline; text-align:start; }
    .turn-nav-label { flex:none; color:var(--text-secondary); font-size:12px; }
    .turn-nav-preview { min-width:0; white-space:normal; overflow-wrap:anywhere; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
    @media (pointer:coarse) { .turn-nav-trigger { min-height:44px; } }
  `;
  document.head.appendChild(style);
}
