import { PROVIDER_IDS, renderProviderLogoMarkup, type ProviderId } from "../provider-identity.js";

// A local, decorative model of Wand: provider CLIs feed one workspace, with
// terminal/chat panes, a Git branch and a mobile client. No live session data.
const PROVIDER_POSITIONS: Record<ProviderId, readonly [number, number]> = {
  claude: [54, 128],
  codex: [142, 70],
  opencode: [240, 46],
  grok: [340, 46],
  qoder: [438, 70],
  pi: [526, 128],
};

function renderProviderConnections(): string {
  return PROVIDER_IDS.map((provider, index) => {
    const [x, y] = PROVIDER_POSITIONS[provider];
    const path = `M${x} ${y + 25} C${x} ${y + 82} 290 118 290 192`;
    // Nested SVGs need viewport attributes; CSS size alone can leave them at 100%.
    const logo = renderProviderLogoMarkup(provider).replace("<svg ", '<svg width="26" height="26" ');
    return `<g style="--lv-delay: ${-index * 1.25}s">
      <path class="login-visual-wire" d="${path}"/>
      <path class="login-visual-signal" d="${path}" pathLength="1"/>
      <g transform="translate(${x - 25} ${y - 25})">
        <rect class="login-visual-node" width="50" height="50" rx="15"/>
        <g transform="translate(12 12)">${logo}</g>
      </g>
    </g>`;
  }).join("");
}

/** The supplied mark is the same local SVG used by the login page's wordmark. */
export function renderLoginVisual(brandMark: string): string {
  const mark = brandMark.replace("<svg ", '<svg width="44" height="44" ');
  return `<div class="login-visual">
    <input id="login-visual-paused" class="login-visual-toggle" type="checkbox"
      aria-label="暂停插画动效"/>
    <label class="login-visual-control" for="login-visual-paused" aria-hidden="true"
      title="暂停 / 播放插画动效">
      <svg class="login-visual-pause-icon" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.5" focusable="false">
        <path d="M9 6v12M15 6v12"/>
      </svg>
      <svg class="login-visual-play-icon" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.5" focusable="false">
        <path d="m9 5 10 7-10 7Z"/>
      </svg>
    </label>
    <svg class="login-visual-scene" viewBox="0 0 580 480" fill="none"
      aria-hidden="true" focusable="false">
      <ellipse class="login-visual-orbit" cx="290" cy="246" rx="255" ry="203"/>
      <ellipse class="login-visual-orbit" cx="290" cy="246" rx="225" ry="176"/>
      <path class="login-visual-registration" d="M21 218h10m-5-5v10M551 218h10m-5-5v10M285 455h10m-5-5v10"/>
      ${renderProviderConnections()}

      <rect class="login-visual-backplate" x="100" y="206" width="376" height="214" rx="14"/>
      <rect class="login-visual-backplate" x="92" y="198" width="376" height="214" rx="14"/>
      <rect class="login-visual-window" x="84" y="190" width="376" height="214" rx="14"/>
      <path class="login-visual-rule" d="M84 228h376M138 228v176"/>
      <g class="login-visual-window-dots">
        <circle cx="103" cy="209" r="3"/>
        <circle cx="114" cy="209" r="3"/>
        <circle cx="125" cy="209" r="3"/>
      </g>
      <rect class="login-visual-tab" x="156" y="201" width="45" height="16" rx="5"/>
      <path class="login-visual-muted-line" d="M169 209h19M213 209h24"/>
      <circle class="login-visual-online" cx="438" cy="209" r="3"/>
      <g transform="translate(268 168)">${mark}</g>

      <g class="login-visual-sidebar" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect class="login-visual-tab" x="96" y="241" width="30" height="30" rx="7" stroke="none"/>
        <path class="login-visual-accent-stroke" d="m104 251 5 5-5 5m9 0h5"/>
        <path d="M102 290h7l3 3h9v12h-19Zm0 36h19v12h-10l-5 4v-4h-4Z"/>
        <path d="M105 375h13m-13 5h8"/>
      </g>

      <rect class="login-visual-terminal" x="150" y="240" width="192" height="150" rx="7"/>
      <g class="login-visual-code" stroke-width="4" stroke-linecap="round">
        <path class="login-visual-code-accent" d="M166 259h13m9 0h34"/>
        <path d="M166 274h28m9 0h52m9 0h15"/>
        <path d="M175 288h43m9 0h24"/>
        <path d="M175 302h25m9 0h58m9 0h21"/>
        <path class="login-visual-code-accent" d="M166 326h13m9 0h25"/>
        <path d="M166 341h52m9 0h35"/>
        <path class="login-visual-output" d="M175 355h37m9 0h51"/>
        <path class="login-visual-cursor" d="M166 376h7"/>
      </g>
      <g class="login-visual-chat">
        <rect class="login-visual-chat-card" x="353" y="240" width="94" height="43" rx="7"/>
        <path class="login-visual-muted-line" d="M366 254h51m-51 10h34"/>
        <rect class="login-visual-chat-card" x="353" y="293" width="94" height="58" rx="7"/>
        <circle class="login-visual-online" cx="367" cy="307" r="3"/>
        <path class="login-visual-muted-line" d="M378 307h29m-41 13h55m-55 10h36"/>
        <rect class="login-visual-tab" x="353" y="361" width="94" height="29" rx="7"/>
        <path class="login-visual-accent-stroke" d="m365 376 3 3 6-7m12 4h28"/>
      </g>

      <path class="login-visual-wire" d="M84 312H58a14 14 0 0 0-14 14v49"/>
      <path class="login-visual-wire" d="M66 398h48a14 14 0 0 1 14 14v20h266"/>
      <g transform="translate(20 374)">
        <rect class="login-visual-git-tile" width="48" height="48" rx="14"/>
        <g class="login-visual-git" stroke-width="1.8">
          <circle cx="17" cy="13" r="3"/><circle cx="31" cy="15" r="3"/>
          <circle cx="17" cy="35" r="3"/>
          <path d="M17 16v16m14-14v2c0 8-14 4-14 12"/>
        </g>
      </g>
      <circle class="login-visual-sync-dot" cx="245" cy="432" r="4"/>

      <g class="login-visual-phone">
        <rect class="login-visual-phone-shadow" x="409" y="307" width="102" height="163" rx="19"/>
        <rect class="login-visual-device" x="402" y="300" width="102" height="163" rx="19"/>
        <rect class="login-visual-phone-screen" x="409" y="307" width="88" height="149" rx="13"/>
        <path class="login-visual-muted-line" d="M442 318h22M443 447h20"/>
        <circle class="login-visual-online" cx="483" cy="331" r="2.5"/>
        <g transform="translate(417 326) scale(.42)">${mark}</g>
        <rect class="login-visual-terminal" x="417" y="351" width="72" height="48" rx="5"/>
        <g class="login-visual-code" stroke-width="2.5" stroke-linecap="round">
          <path class="login-visual-code-accent" d="M425 361h8m7 0h15"/>
          <path d="M425 371h32m-32 8h16m6 0h20"/>
          <path class="login-visual-output" d="M425 389h26"/>
        </g>
        <rect class="login-visual-chat-card" x="417" y="407" width="72" height="26" rx="5"/>
        <path class="login-visual-git" d="m425 420 3 3 6-7" stroke-width="1.5"/>
        <path class="login-visual-muted-line" d="M442 420h35"/>
      </g>
    </svg>
  </div>`;
}
