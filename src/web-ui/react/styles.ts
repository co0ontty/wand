import {
  foundationStyles,
  reducedMotionStyles,
  sharedMotionStyles,
} from "./styles/base";
import {
  sessionPickerAndWorktreeStyles,
  settingsAndQuickCommitStyles,
} from "./styles/features";

const REACT_UI_STYLE_ID = "wand-react-ui-styles";

// Keep the historical cascade order while allowing base and business styles to
// evolve independently behind this single installation interface.
const reactUiStyles = [
  foundationStyles,
  settingsAndQuickCommitStyles,
  sharedMotionStyles,
  sessionPickerAndWorktreeStyles,
  reducedMotionStyles,
].join("");

export function installReactUiStyles(target: Document = document): void {
  if (target.getElementById(REACT_UI_STYLE_ID)) return;
  const style = target.createElement("style");
  style.id = REACT_UI_STYLE_ID;
  style.textContent = reactUiStyles;
  target.head.appendChild(style);
}
