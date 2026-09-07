import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as React from "react";
import { classNames } from "./class-names";
import { WandIcon } from "./icons";
import { usePortalContainer } from "./portal-context";

void React;

export interface WandSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface WandSelectProps {
  value?: string;
  defaultValue?: string;
  options: ReadonlyArray<WandSelectOption>;
  placeholder?: string;
  displayValue?: string;
  ariaLabel: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  className?: string;
  contentClassName?: string;
  itemClassName?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  collisionPadding?: number;
  onValueChange?(value: string): void;
  onOpenChange?(open: boolean): void;
}

export function filterSelectOptions(
  options: ReadonlyArray<WandSelectOption>,
  query: string,
): WandSelectOption[] {
  const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (needles.length === 0) return options.slice();
  return options.filter((option) => {
    const haystack = `${option.value} ${option.label}`.toLowerCase();
    return needles.every((needle) => haystack.includes(needle));
  });
}

export function WandSelect(props: WandSelectProps) {
  if (props.searchable) return <SearchableWandSelect {...props} />;
  return <ClassicWandSelect {...props} />;
}

function ClassicWandSelect({
  value,
  defaultValue,
  options,
  placeholder = "请选择",
  displayValue,
  ariaLabel,
  disabled,
  className,
  contentClassName,
  itemClassName,
  side,
  align,
  sideOffset = 6,
  collisionPadding = 12,
  onValueChange,
  onOpenChange,
}: WandSelectProps) {
  const portalContainer = usePortalContainer();
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      onValueChange={onValueChange}
      onOpenChange={onOpenChange}
    >
      <SelectPrimitive.Trigger
        className={classNames("wand-ui-select-trigger", className)}
        aria-label={ariaLabel}
      >
        <SelectPrimitive.Value placeholder={placeholder}>{displayValue}</SelectPrimitive.Value>
        <SelectPrimitive.Icon aria-hidden="true">⌄</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={portalContainer}>
        <SelectPrimitive.Content
          className={classNames("wand-ui-select-content", contentClassName)}
          position="popper"
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
        >
          <SelectPrimitive.ScrollUpButton className="wand-ui-select-scroll-button">
            ⌃
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="wand-ui-select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={optionKey(option.value)}
                className={classNames("wand-ui-select-item", itemClassName)}
                value={option.value}
                disabled={option.disabled}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="wand-ui-select-indicator">
                  <WandIcon name="check" size={12}/>
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="wand-ui-select-scroll-button">
            ⌄
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function SearchableWandSelect({
  value,
  defaultValue,
  options,
  placeholder = "请选择",
  displayValue,
  ariaLabel,
  disabled,
  searchPlaceholder = "搜索",
  className,
  contentClassName,
  itemClassName,
  side,
  align,
  sideOffset = 6,
  collisionPadding = 12,
  onValueChange,
  onOpenChange,
}: WandSelectProps) {
  const portalContainer = usePortalContainer();
  const listId = React.useId();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue ?? "");
  const current = value !== undefined ? value : uncontrolled;
  const filtered = React.useMemo(() => filterSelectOptions(options, query), [options, query]);
  const [highlight, setHighlight] = React.useState(0);
  const selectedLabel = options.find((option) => option.value === current)?.label;
  const shown = displayValue || selectedLabel;
  const safeHighlight = filtered.length === 0 ? 0 : Math.min(highlight, filtered.length - 1);
  const activeId = filtered[safeHighlight] ? `${listId}-option-${safeHighlight}` : undefined;

  React.useLayoutEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector("[data-highlighted]");
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
  }, [open, highlight, filtered]);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setQuery("");
      const selectedIndex = options.findIndex((option) => option.value === current && !option.disabled);
      setHighlight(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options));
    }
    onOpenChange?.(next);
  }

  function commit(next: string): void {
    if (value === undefined) setUncontrolled(next);
    onValueChange?.(next);
    handleOpenChange(false);
  }

  function moveHighlight(delta: number): void {
    if (filtered.length === 0) return;
    let index = safeHighlight;
    for (let step = 0; step < filtered.length; step += 1) {
      index = (index + delta + filtered.length) % filtered.length;
      if (!filtered[index]?.disabled) {
        setHighlight(index);
        return;
      }
    }
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setHighlight(firstEnabledIndex(filtered));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setHighlight(lastEnabledIndex(filtered));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[safeHighlight];
      if (option && !option.disabled) commit(option.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handleOpenChange(false);
    }
  }

  function onQueryChange(next: string): void {
    setQuery(next);
    const nextOptions = filterSelectOptions(options, next);
    const selectedIndex = nextOptions.findIndex((option) => option.value === current && !option.disabled);
    setHighlight(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(nextOptions));
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger
        className={classNames("wand-ui-select-trigger", className)}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        data-placeholder={shown ? undefined : ""}
      >
        <span>{shown || placeholder}</span>
        <span aria-hidden="true">⌄</span>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={portalContainer}>
        <PopoverPrimitive.Content
          className={classNames("wand-ui-select-content", "wand-ui-select-searchable", contentClassName)}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
        >
          <div className="wand-ui-select-search">
            <input
              ref={searchRef}
              className="wand-ui-select-search-input"
              type="text"
              value={query}
              placeholder={searchPlaceholder}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <div
            ref={listRef}
            id={listId}
            className="wand-ui-select-viewport"
            role="listbox"
            aria-label={ariaLabel}
          >
            {filtered.length === 0 ? (
              <div className="wand-ui-select-empty">没有匹配的模型</div>
            ) : filtered.map((option, index) => {
              const selected = option.value === current;
              const highlighted = index === safeHighlight;
              return (
                <button
                  key={optionKey(option.value)}
                  id={`${listId}-option-${index}`}
                  type="button"
                  role="option"
                  className={classNames("wand-ui-select-item", itemClassName)}
                  value={option.value}
                  disabled={option.disabled}
                  aria-selected={selected}
                  data-highlighted={highlighted ? "" : undefined}
                  data-state={selected ? "checked" : undefined}
                  onMouseEnter={() => {
                    if (!option.disabled) setHighlight(index);
                  }}
                  onClick={() => {
                    if (!option.disabled) commit(option.value);
                  }}
                >
                  <span>{option.label}</span>
                  {selected ? (
                    <span className="wand-ui-select-indicator">
                      <WandIcon name="check" size={12}/>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function optionKey(value: string): string {
  return value === "" ? "__default__" : value;
}

function firstEnabledIndex(options: ReadonlyArray<WandSelectOption>): number {
  const index = options.findIndex((option) => !option.disabled);
  return index >= 0 ? index : 0;
}

function lastEnabledIndex(options: ReadonlyArray<WandSelectOption>): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return Math.max(options.length - 1, 0);
}
