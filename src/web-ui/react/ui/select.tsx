import {
  Combobox as AppicaCombobox,
  ComboboxContent as AppicaComboboxContent,
  ComboboxEmpty as AppicaComboboxEmpty,
  ComboboxInput as AppicaComboboxInput,
  ComboboxItem as AppicaComboboxItem,
  ComboboxList as AppicaComboboxList,
  ComboboxTrigger as AppicaComboboxTrigger,
  ComboboxValue as AppicaComboboxValue,
} from "@appica/ui-react/combobox";
import {
  Select as AppicaSelect,
  SelectContent as AppicaSelectContent,
  SelectItem as AppicaSelectItem,
  SelectTrigger as AppicaSelectTrigger,
  SelectValue as AppicaSelectValue,
} from "@appica/ui-react/select";
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

/**
 * Wand's dropdown, rendered by Appica UI.
 *
 * Two library primitives back it: `Select` when the list is a plain menu, and
 * `Combobox` when the popup owns a search field ("input inside popup" mode in
 * Base UI - the trigger stays a combobox button, the popup is a dialog that
 * autofocuses the search box and clears it again on close). Both keep the
 * `wand-ui-select-*` classes so business stylesheets stay in charge of the look.
 */
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
    <AppicaSelect
      items={options}
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      /* Wand's selects are inline poppers without a scrim, so page scroll stays live. */
      modal={false}
      /* Wand wants a plain popper under the trigger, not Appica's overlay-the-trigger effect. */
      alignItemWithTrigger={false}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange?.(next);
      }}
      onOpenChange={(open) => onOpenChange?.(open)}
    >
      <AppicaSelectTrigger
        className={classNames("wand-ui-select-trigger", className)}
        aria-label={ariaLabel}
      >
        <AppicaSelectValue
          className="wand-ui-select-value"
          placeholder={placeholder}
          children={displayValue}
        />
      </AppicaSelectTrigger>
      <AppicaSelectContent
        className={classNames("wand-ui-select-content", contentClassName)}
        container={portalContainer}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
      >
        {options.map((option) => (
          <AppicaSelectItem
            key={optionKey(option.value)}
            className={classNames("wand-ui-select-item", itemClassName)}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </AppicaSelectItem>
        ))}
      </AppicaSelectContent>
    </AppicaSelect>
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
  const selected = findOption(options, value);
  const shown = displayValue || selected?.label;
  return (
    <AppicaCombobox
      items={options as WandSelectOption[]}
      value={selected}
      defaultValue={findOption(options, defaultValue)}
      disabled={disabled}
      /* Highlight the current selection when the popup opens, like the old hand-rolled list. */
      autoHighlight
      /* The popup owns the search field, so it must start blank instead of pre-filled with the
         selected label - otherwise the first keystroke would append to the current model name. */
      defaultInputValue=""
      /* Appica's `ComboboxInput` renders its own toggle button by default - a second
         `Combobox.Trigger` that lives *inside* the popup. Base UI keeps only the last
         registered trigger as the positioning anchor, so the popup would chase an element
         it owns and drift one frame per layout pass instead of sticking to the trigger
         button. The outer trigger already draws the chevron, so the toggle is redundant. */
      icon={false}
      isItemEqualToValue={sameOption}
      filter={filterComboboxItem}
      onValueChange={(next) => {
        const nextValue = optionValue(next);
        if (nextValue !== undefined) onValueChange?.(nextValue);
      }}
      onOpenChange={(open) => onOpenChange?.(open)}
    >
      <AppicaComboboxTrigger
        className={classNames("wand-ui-select-trigger", className)}
        aria-label={ariaLabel}
      >
        <span className="wand-ui-select-value">
          <AppicaComboboxValue placeholder={placeholder} children={shown ? () => shown : undefined}/>
        </span>
      </AppicaComboboxTrigger>
      <AppicaComboboxContent
        className={classNames(
          "wand-ui-select-content",
          "wand-ui-select-searchable",
          contentClassName,
        )}
        container={portalContainer}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
      >
        <div className="wand-ui-select-search">
          <AppicaComboboxInput
            className="wand-ui-select-search-input"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            startSlot={(
              <WandIcon
                className="wand-ui-select-search-icon"
                name="search"
                size={13}
                strokeWidth={2}
              />
            )}
          />
        </div>
        <AppicaComboboxEmpty className="wand-ui-select-empty">没有匹配的选项</AppicaComboboxEmpty>
        <AppicaComboboxList className="wand-ui-select-viewport">
          {(option: WandSelectOption) => (
            <AppicaComboboxItem
              key={optionKey(option.value)}
              className={classNames("wand-ui-select-item", itemClassName)}
              value={option}
              disabled={option.disabled}
            >
              {option.label}
            </AppicaComboboxItem>
          )}
        </AppicaComboboxList>
      </AppicaComboboxContent>
    </AppicaCombobox>
  );
}

/**
 * Matches a whitespace-separated AND query against the option's value *and* label,
 * so "gpt 5.4" finds `openai/gpt-5.4` / "GPT-5.4". One predicate drives both the
 * searchable popup's filter and the exported helper, so they cannot drift apart.
 */
export function filterSelectOptions(
  options: ReadonlyArray<WandSelectOption>,
  query: string,
): WandSelectOption[] {
  if (!query.trim()) return options.slice();
  return options.filter((option) => matchesQuery(optionSearchText(option), query));
}

function filterComboboxItem(
  item: unknown,
  query: string,
  itemToString?: (value: unknown) => string,
): boolean {
  return matchesQuery(optionSearchText(item, itemToString), query);
}

function matchesQuery(text: string, query: string): boolean {
  const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (needles.length === 0) return true;
  const haystack = text.toLowerCase();
  return needles.every((needle) => haystack.includes(needle));
}

function optionSearchText(item: unknown, itemToString?: (value: unknown) => string): string {
  const value = optionValue(item);
  const label = optionLabel(item, itemToString);
  return value === undefined ? label : `${value} ${label}`;
}

function optionValue(item: unknown): string | undefined {
  if (isWandSelectOption(item)) return item.value;
  return typeof item === "string" ? item : undefined;
}

function optionLabel(item: unknown, itemToString?: (value: unknown) => string): string {
  if (isWandSelectOption(item)) return item.label;
  if (itemToString && item != null) return itemToString(item);
  return typeof item === "string" ? item : "";
}

function isWandSelectOption(item: unknown): item is WandSelectOption {
  return typeof item === "object" && item !== null && typeof (item as WandSelectOption).value === "string";
}

function sameOption(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left === right;
  return optionValue(left) === optionValue(right);
}

function findOption(
  options: ReadonlyArray<WandSelectOption>,
  value: string | undefined,
): WandSelectOption | undefined {
  if (value === undefined) return undefined;
  return options.find((option) => option.value === value);
}

function optionKey(value: string): string {
  return value === "" ? "__default__" : value;
}
