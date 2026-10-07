import { Dropdown, type MenuProps, type DropdownProps } from "antd";
import * as React from "react";
import { WandButton } from "./button";
import { classNames } from "./class-names";
import { WandIcon, type WandIconName, type WandIconSlot } from "./icons";
import { usePortalContainer } from "./portal-context";
import { popupPlacement, popupOffset, usePopupDismiss } from "./popup-lifecycle";
import { WandUiBoundary } from "../theme";

export interface WandDropdownMenuProps {
  children: React.ReactNode;
  contextTrigger?: React.ReactElement;
  triggers?: DropdownProps["trigger"];
  open?: boolean;
  defaultOpen?: boolean;
  modal?: boolean;
  onOpenChange?(open: boolean): void;
}
export interface WandDropdownMenuTriggerProps extends React.ComponentPropsWithRef<"button"> {
  render?: React.ReactElement<React.ComponentPropsWithRef<"button">>;
}
export interface WandDropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  container?: HTMLElement;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  collisionPadding?: number;
  popupOwner?: string;
}
export interface WandDropdownMenuItemProps extends Omit<React.ComponentPropsWithRef<"button">, "children"> {
  icon?: WandIconName;
  iconSlot?: WandIconSlot;
  hint?: React.ReactNode;
  tone?: "default" | "danger";
  children: React.ReactNode;
  onSelect?(): void;
}
export interface WandDropdownMenuSeparatorProps { className?: string; }

type Item = NonNullable<MenuProps["items"]>[number];
type RegisteredItem = { item: Item; marker: HTMLSpanElement | null };
type RegisterItem = (key: string, item: Item, marker: HTMLSpanElement | null) => () => void;
const MenuRegistration = React.createContext<RegisterItem | null>(null);

export function WandDropdownMenu({ children, contextTrigger, triggers = ["click"], open, defaultOpen = false, onOpenChange }: WandDropdownMenuProps) {
  const portal = usePortalContainer();
  const triggerRef = React.useRef<HTMLElement>(null);
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const [registeredItems, setRegisteredItems] = React.useState<Map<string, RegisteredItem>>(() => new Map());
  const register = React.useCallback<RegisterItem>((key, item, marker) => {
    setRegisteredItems(previous => new Map(previous).set(key, { item, marker }));
    return () => setRegisteredItems(previous => { const next = new Map(previous); next.delete(key); return next; });
  }, []);
  const shown = open ?? internalOpen;
  const change = (next: boolean): void => { setInternalOpen(next); onOpenChange?.(next); };
  const parts = React.Children.toArray(children).filter(React.isValidElement);
  const trigger = parts.find(part => part.type === WandDropdownMenuTrigger) as React.ReactElement<WandDropdownMenuTriggerProps> | undefined;
  const content = parts.find(part => part.type === WandDropdownMenuContent) as React.ReactElement<WandDropdownMenuContentProps> | undefined;
  usePopupDismiss(shown, () => { change(false); triggerRef.current?.focus({ preventScroll: true }); });
  if ((!trigger && !contextTrigger) || !content) return null;
  const { align = "start", side = "bottom", sideOffset = 6, container, collisionPadding = 12, popupOwner,
    className, children: declarations, ...attributes } = content.props;
  return <WandUiBoundary>
    <MenuRegistration.Provider value={register}>{declarations}</MenuRegistration.Provider>
    <Dropdown ref={triggerRef} open={shown} onOpenChange={change} trigger={triggers}
      getPopupContainer={() => container ?? portal ?? document.body}
      placement={popupPlacement(side, align)} destroyOnHidden autoFocus
      align={{ offset: popupOffset(side, sideOffset), overflow: { adjustX: true, adjustY: true, shiftX: collisionPadding, shiftY: collisionPadding } }}
      classNames={{ root: classNames("wand-ui-dropdown-content", className) }}
      menu={{ items: [...registeredItems.values()].sort((a, b) => {
        if (!a.marker || !b.marker) return 0;
        const position = a.marker.compareDocumentPosition(b.marker);
        return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
      }).map(entry => entry.item), selectable: false, onClick: () => change(false) }}
      popupRender={menu => <div {...attributes} data-wand-popup-owner={popupOwner ?? attributes.id}>{menu}</div>}>
      {contextTrigger ?? React.cloneElement(trigger!, { "aria-haspopup": "menu", "aria-expanded": shown, "aria-controls": attributes.id })}
    </Dropdown>
  </WandUiBoundary>;
}
export function WandDropdownMenuTrigger({ render, className, ...props }: WandDropdownMenuTriggerProps) {
  return render ? React.cloneElement(render, { ...props, className: classNames("wand-ui-dropdown-trigger", render.props.className, className) })
    : <WandButton {...props} type={props.type ?? "button"} className={classNames("wand-ui-dropdown-trigger", className)}/>;
}
export function WandDropdownMenuContent(_props: WandDropdownMenuContentProps) { return null; }
export function WandDropdownMenuItem({ className, icon, iconSlot = "start", hint, tone, children, onSelect, onClick, ...props }: WandDropdownMenuItemProps) {
  const register = React.useContext(MenuRegistration);
  const key = React.useId();
  const marker = React.useRef<HTMLSpanElement>(null);
  const { type: _type, ...attributes } = props;
  const latest = React.useRef({ onSelect, onClick });
  latest.current = { onSelect, onClick };
  const item = React.useMemo<Item>(() => ({ ...attributes as unknown as Exclude<Item, null>, key, danger: tone === "danger",
    className: classNames("wand-ui-dropdown-item", className),
    icon: icon ? <WandIcon name={icon} slot={iconSlot} size={15}/> : undefined,
    label: <>{children}{hint != null ? <span className="wand-ui-dropdown-item-hint">{hint}</span> : null}</>,
    onClick: ({ domEvent }) => {
      latest.current.onClick?.(domEvent as unknown as React.MouseEvent<HTMLButtonElement>);
      latest.current.onSelect?.();
    },
  }), [key, props.id, props.disabled, props.title, className, tone, icon, iconSlot, hint, children]);
  React.useLayoutEffect(() => register?.(key, item, marker.current), [register, key, item]);
  return <span hidden ref={marker}/>;
}
export function WandDropdownMenuSeparator({ className }: WandDropdownMenuSeparatorProps) {
  const register = React.useContext(MenuRegistration);
  const key = React.useId();
  const marker = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => register?.(key, { key, type: "divider", className }, marker.current), [register, key, className]);
  return <span hidden ref={marker}/>;
}
