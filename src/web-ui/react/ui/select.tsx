import { type MenuProps } from "antd";
import * as React from "react";
import type { DropdownSurfaceProps } from "./dropdown-surface";
import { classNames } from "./class-names";
import { WandIcon } from "./icons";
import { WandButton, type WandButtonKind } from "./button";
import { WandInput } from "./input";
import { useParentPopupOwner, usePortalContainer } from "./portal-context";
import { popupPlacement, popupOffset, registerPopupOwner, usePopupDismiss } from "./popup-lifecycle";
import { WandUiBoundary } from "../theme";

export interface WandSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

export interface WandSelectProps extends Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, "id" | "aria-describedby" | "aria-invalid"> {
  value?: string;
  defaultValue?: string;
  options: ReadonlyArray<WandSelectOption>;
  placeholder?: string;
  displayValue?: string;
  /** 悬停 tooltip 用的完整值，不参与可见文本；缺省时回退 displayValue。 */
  displayTitle?: string;
  ariaLabel: string;
  triggerRef?: React.Ref<HTMLButtonElement>;
  disabled?: boolean;
  triggerKind?: WandButtonKind;
  searchable?: boolean;
  searchPlaceholder?: string;
  className?: string;
  contentClassName?: string;
  itemClassName?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  collisionPadding?: number;
  popupOwner?: string;
  onValueChange?(value: string): void;
  onOpenChange?(open: boolean): void;
}


/** A real button ref and popup-owned search are required by the composer focus lease. */
export function WandSelect({ value, defaultValue, options, placeholder = "请选择", displayValue, displayTitle,
  ariaLabel, id, "aria-describedby": describedBy, "aria-invalid": invalid, triggerRef, disabled, triggerKind, searchable, searchPlaceholder = "搜索", className, contentClassName,
  itemClassName, side = "bottom", align = "start", sideOffset = 6, collisionPadding = 12, popupOwner = ariaLabel, onValueChange, onOpenChange }: WandSelectProps) {
  const portal = usePortalContainer();
  const parentOwner = useParentPopupOwner();
  React.useEffect(() => registerPopupOwner(popupOwner, parentOwner), [popupOwner, parentOwner]);
  const listId = React.useId();
  const [internalValue, setInternalValue] = React.useState(defaultValue);
  const selectedValue = value === undefined ? internalValue : value;
  const [open, setOpen] = React.useState(false);
  const openRef = React.useRef(false);
  const [query, setQuery] = React.useState("");
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  // A portal search box must not scroll its enclosing Drawer back to the top on mount.
  const focusSearch = React.useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    const frame = requestAnimationFrame(() => { if (openRef.current && node.isConnected) node.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, []);
  const shown = displayValue ?? options.find(option => option.value === selectedValue)?.label ?? placeholder;
  const changeOpen = (next: boolean): void => {
    openRef.current = next;
    setOpen(next);
    if (!next) setQuery("");
    onOpenChange?.(next);
  };
  const filtered = filterSelectOptions(options, query);
  const items: MenuProps["items"] = [];
  filtered.forEach((option, index) => {
    if (option.group !== filtered[index - 1]?.group && (option.group || filtered[index - 1]?.group)) {
      items.push({ type: "group", key: `group:${index}`, label: option.group || "其他模型", children: [] });
    }
    const item = { key: option.value, label: option.label, title: option.label, disabled: option.disabled,
      role: "option", "aria-selected": option.value === selectedValue,
      className: classNames("wand-ui-select-item", itemClassName) };
    items.push(item);
  });
  usePopupDismiss(open, () => { changeOpen(false); buttonRef.current?.focus({ preventScroll: true }); });
  React.useEffect(() => { if (disabled && open) changeOpen(false); }, [disabled, open]);
  // 弹层实现（antd Dropdown + Menu）单独成块：选择器只在真的点开时才需要。
  const [Surface, setSurface] = React.useState<React.ComponentType<DropdownSurfaceProps> | null>(null);
  const surfaceRequest = React.useRef<Promise<void> | null>(null);
  const loadSurface = React.useCallback((): Promise<void> => {
    if (Surface) return Promise.resolve();
    if (!surfaceRequest.current) {
      surfaceRequest.current = import("./dropdown-surface").then(module => { setSurface(() => module.DropdownSurface); });
    }
    return surfaceRequest.current;
  }, [Surface]);
  React.useEffect(() => { if (open) void loadSurface(); }, [open, loadSurface]);
  const triggerButton = <WandButton ref={node => {
    buttonRef.current = node;
    if (typeof triggerRef === "function") return triggerRef(node);
    if (triggerRef) triggerRef.current = node;
  }} kind={triggerKind} id={id} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} className={classNames("wand-ui-select-trigger", className)}
    data-popup-open={open ? "" : undefined} data-placeholder={selectedValue === undefined && !displayValue ? "" : undefined}
    aria-controls={open ? listId : undefined} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
    title={displayTitle ?? shown}>
    <span className="wand-ui-select-value">{shown}</span><WandIcon name="chevronDown" size={14}/>
  </WandButton>;
  // 弹层实现还没到时，触发器自己接住这一次点击；实现到达后由 Ant 接管开合。
  const pendingTriggerButton = <WandButton ref={node => {
    buttonRef.current = node;
    if (typeof triggerRef === "function") return triggerRef(node);
    if (triggerRef) triggerRef.current = node;
  }} kind={triggerKind} id={id} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} className={classNames("wand-ui-select-trigger", className)}
    data-popup-open={open ? "" : undefined} data-placeholder={selectedValue === undefined && !displayValue ? "" : undefined}
    aria-controls={open ? listId : undefined} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
    title={displayTitle ?? shown}
    onClick={() => { if (!disabled) changeOpen(true); }}>
    <span className="wand-ui-select-value">{shown}</span><WandIcon name="chevronDown" size={14}/>
  </WandButton>;
  return <WandUiBoundary>{Surface
    ? <Surface trigger={triggerButton} open={open} triggers={["click"]} disabled={disabled}
      onOpenChange={(next, info) => { if (info.source === "trigger") changeOpen(next); }}
      getPopupContainer={() => portal ?? document.body} placement={popupPlacement(side, align)} destroyOnHidden
      align={{ offset: popupOffset(side, sideOffset), overflow: { adjustX: true, adjustY: true, shiftX: collisionPadding, shiftY: collisionPadding } }}
      classNames={{ root: classNames("wand-ui-select-content", searchable && "wand-ui-select-searchable", contentClassName) }}
      menu={{ id: listId, items, role: "listbox", selectable: true, selectedKeys: selectedValue === undefined ? [] : [selectedValue],
        onClick: ({ key }) => { setInternalValue(key); onValueChange?.(key); changeOpen(false); buttonRef.current?.focus({ preventScroll: true }); } }}
      popupRender={menuNode => <div ref={popupRef} data-wand-popup-owner={popupOwner}>
        {searchable && <WandInput ref={focusSearch} type="search" aria-label={searchPlaceholder} placeholder={searchPlaceholder}
          value={query} onChange={event => setQuery(event.currentTarget.value)}
          startSlot={<WandIcon name="search" size={14}/>}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const enabled = popupRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
              (event.key === "ArrowUp" ? enabled?.[enabled.length - 1] : enabled?.[0])?.focus();
            }
          }}/> }
        {filtered.length ? menuNode : <div role="status">没有匹配的选项</div>}
      </div>}/>
    : pendingTriggerButton}</WandUiBoundary>;
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

function matchesQuery(text: string, query: string): boolean {
  const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return needles.every(needle => text.toLowerCase().includes(needle));
}
function optionSearchText(option: WandSelectOption): string {
  return `${option.value} ${option.label} ${option.group ?? ""}`;
}
