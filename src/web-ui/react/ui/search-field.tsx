import * as React from "react";
import { WandIcon } from "./icons";
import { WandIconButton } from "./button";
import { classNames } from "./class-names";

export interface WandSearchFieldProps {
  value: string;
  onValueChange(value: string): void;
  /** Run local filtering immediately, or hand remote search to its controller. */
  onSearch?(value: string): void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /**
   * Id of the listbox this field filters. Supplying it turns the field into a
   * combobox so the highlighted option stays reachable by screen readers while
   * the caret never leaves the input.
   */
  listId?: string;
  /** Id of the currently highlighted option inside `listId`. */
  activeOptionId?: string;
}

/** Search owns its clear action and IME boundary; repositories own request cancellation. */
export function WandSearchField({
  value, onValueChange, onSearch, label, placeholder = label, disabled, className, inputRef,
  listId, activeOptionId,
}: WandSearchFieldProps): React.ReactElement {
  const internalRef = React.useRef<HTMLInputElement>(null);
  const ref = inputRef ?? internalRef;
  const composing = React.useRef(false);
  const clear = (): void => {
    composing.current = false;
    onValueChange("");
    onSearch?.("");
    ref.current?.focus();
  };
  return <div className={classNames("wand-ui-search", className)}>
    <WandIcon name="search" size={16}/>
    <input
      ref={ref}
      type="search"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      role={listId ? "combobox" : undefined}
      aria-expanded={listId ? true : undefined}
      aria-autocomplete={listId ? "list" : undefined}
      aria-controls={listId}
      aria-activedescendant={activeOptionId}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(event) => {
        composing.current = false;
        onSearch?.(event.currentTarget.value);
      }}
      onChange={(event) => {
        const next = event.currentTarget.value;
        onValueChange(next);
        if (!composing.current) onSearch?.(next);
      }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && value) {
          event.preventDefault();
          event.stopPropagation();
          clear();
        }
      }}
    />
    {value && <WandIconButton aria-label={`清除${label}`} title={`清除${label}`} disabled={disabled} onClick={clear}>
      <WandIcon name="close" size={14}/>
    </WandIconButton>}
  </div>;
}
