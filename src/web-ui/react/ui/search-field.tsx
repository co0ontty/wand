import * as React from "react";
import { WandIcon } from "./icons";
import { WandInput } from "./input";
import { classNames } from "./class-names";
import { useImeGuard } from "../composer-sender/ime-guard";

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
  const ime = useImeGuard();
  // Text commits may arrive after compositionend; only keyboard actions need the trailing guard.
  const composingText = React.useRef(false);
  const clear = (): void => {
    ime.reset();
    composingText.current = false;
    onValueChange("");
    onSearch?.("");
    ref.current?.focus();
  };
  return <WandInput className={classNames("wand-ui-search", className)}
      startSlot={<WandIcon name="search" size={16}/>}
      clearable={Boolean(value)} clearLabel="清空搜索" onClear={clear}
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
      onCompositionStart={() => { composingText.current = true; ime.onCompositionStart(); }}
      onCompositionEnd={(event) => {
        composingText.current = false;
        ime.onCompositionEnd();
        onSearch?.(event.currentTarget.value);
      }}
      onChange={(event) => {
        const next = event.currentTarget.value;
        onValueChange(next);
        if (!composingText.current) onSearch?.(next);
      }}
      onKeyDown={(event) => {
        if (ime.shouldIgnore(event)) return;
        if (event.key === "Escape" && value) {
          event.preventDefault();
          event.stopPropagation();
          clear();
        }
      }}
    />;
}
