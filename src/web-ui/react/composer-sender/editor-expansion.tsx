import * as React from "react";
import { WandButton } from "../ui/button.js";
import { WandIcon } from "../ui/icons.js";

/** Keep the same input node and draft owner when opening a larger editing area. */
export function useEditorExpansion(owner: string, input: () => HTMLTextAreaElement | null | undefined) {
  const [expanded, setExpanded] = React.useState(false);
  const currentOwner = React.useRef(owner); currentOwner.current = owner;
  React.useEffect(() => { setExpanded(false); }, [owner]);
  const toggle = (): void => {
    const capturedOwner = owner;
    const element = input();
    const selection = element && { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, scroll: element.scrollTop };
    setExpanded(value => !value);
    requestAnimationFrame(() => {
      if (!element || capturedOwner !== currentOwner.current || element !== input() || !element.isConnected) return;
      element.focus({ preventScroll: true });
      if (selection) {
        element.setSelectionRange(selection.start, selection.end, selection.direction);
        element.scrollTop = selection.scroll;
      }
    });
  };
  return { expanded, control: <WandButton size="small" kind="ghost" className="composer-expand-editor" aria-expanded={expanded}
    aria-label={expanded ? "收起编辑" : "展开编辑"} title={expanded ? "收起编辑" : "展开编辑"} onClick={toggle}>
    <span className="composer-editor-morph" data-expanded={expanded}>
      <WandIcon name="splitHorizontal" size={16}/><WandIcon name="chevronDown" size={16}/>
    </span>
  </WandButton> };
}
