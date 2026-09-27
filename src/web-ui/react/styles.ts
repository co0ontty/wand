import {
  foundationStyles,
  reducedMotionStyles,
  sharedMotionStyles,
} from "./styles/base";
import {
  aiTeamsStyles,
  composerSelectStyles,
  missionsStyles,
  sessionPickerAndWorktreeStyles,
  settingsAndQuickCommitStyles,
} from "./styles/features";
import { localPreviewStyles } from "./local-preview/styles";
import { imageViewerStyles } from "./image-viewer/styles";

const REACT_UI_STYLE_ID = "wand-react-ui-styles";

// Keep the historical cascade order while allowing base and business styles to
// evolve independently behind this single installation interface.
const reactUiStyles = [
  foundationStyles,
  settingsAndQuickCommitStyles,
  sharedMotionStyles,
  sessionPickerAndWorktreeStyles,
  composerSelectStyles,
  localPreviewStyles,
  imageViewerStyles,
  missionsStyles,
  aiTeamsStyles,
  reducedMotionStyles,
].join("");

export function installReactUiStyles(target: Document = document): void {
  if (target.getElementById(REACT_UI_STYLE_ID)) return;
  const style = target.createElement("style");
  style.id = REACT_UI_STYLE_ID;
  style.textContent = reactUiStyles;
  target.head.appendChild(style);
}

/** 按 id 只装一次的样式表；按需脚本（ai-teams.js）也经它装自己的样式。 */
export function installStyleSheet(id: string, css: string, target: Document = document): void {
  if (target.getElementById(id)) return;
  const style = target.createElement("style");
  style.id = id;
  style.textContent = css;
  target.head.appendChild(style);
}
