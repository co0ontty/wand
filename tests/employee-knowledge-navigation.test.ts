import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { loadReactModule } from "./helpers/react-startup-harness.js";

test("employee drawer knowledge navigation closes its host only after the existing dirty guard accepts", () => {
  const states: unknown[] = [], refs: Array<{ current: unknown }> = [];
  let stateIndex = 0, refIndex = 0, closes = 0, navigations = 0;
  const { api } = loadReactModule("src/web-ui/react/shell/object-profile-panel.tsx", {
    react: { ...React,
      useState(initial: unknown) {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (next: unknown) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
      useRef(initial: unknown) { const index = refIndex++; return refs[index] ??= { current: initial }; },
      useEffect() {},
    },
    "../deferred-feature": { deferredComponent: () => "EmployeeCard" },
    "../ui/portal-context": { usePortalContainer: () => null, PopupOwnerProvider: "PopupOwnerProvider" },
  }, { window: { innerWidth: 1400 } });
  const render = (): React.ReactElement<any>[] => {
    stateIndex = 0; refIndex = 0;
    const elements: React.ReactElement<any>[] = [];
    const walk = (children: React.ReactNode): void => React.Children.forEach(children, node => {
      if (!React.isValidElement(node)) return;
      elements.push(node); walk((node.props as { children?: React.ReactNode }).children);
    });
    walk(api.ObjectProfilePanel({ open: true, employee: { id: "employee-a", name: "员工甲", agents: [] }, triggerRef: { current: null }, onClose: () => { closes++; } }));
    return elements;
  };
  const initial = render();
  initial.find(node => node.props.rootClassName === "wand-object-profile-drawer")!.props.extra.props.onClick();
  let editor = render().find(node => node.type === "EmployeeCard")!;
  editor.props.onDirtyChange(true);
  editor = render().find(node => node.type === "EmployeeCard")!;
  editor.props.onOpenKnowledge(() => { navigations++; });
  assert.equal(closes, 0); assert.equal(navigations, 0);
  const warning = render().find(node => node.props.title === "放弃尚未保存的修改？")!;
  warning.props.action.props.children[0].props.onClick();
  assert.equal(closes, 0); assert.equal(navigations, 0);
  editor = render().find(node => node.type === "EmployeeCard")!;
  editor.props.onOpenKnowledge(() => { navigations++; });
  render().find(node => node.props.title === "放弃尚未保存的修改？")!.props.action.props.children[1].props.onClick();
  assert.equal(closes, 1); assert.equal(navigations, 1);
  const drawer = render().find(node => node.props.rootClassName === "wand-object-profile-drawer")!;
  drawer.props.extra.props.onClick();
  render().find(node => node.type === "EmployeeCard")!.props.onOpenKnowledge(() => { navigations++; });
  assert.equal(closes, 2); assert.equal(navigations, 2, "a clean editor opens the knowledge page immediately");
});
