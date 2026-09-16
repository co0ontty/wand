/**
 * Claude Skills 选择弹层（`#composer-skills-popover`）的 portal 渲染契约。
 *
 * 旧实现有两个 DOM 写入点：种子里的 `renderClaudeSkillsPickerHtml(selectedSession)`
 * （首屏字符串）与 `refreshClaudeSkillsPicker()`（`picker.outerHTML = markup`，
 * 不存在时用 `insertAdjacentElement("afterend")` 插到加号 popover 之后）。
 * 现在弹层内容由 React 渲染，legacy 只发布「打开 / 加载中 / 选项 / 已选数」快照。
 *
 * 触发按钮 `[data-claude-skills-trigger]` 早已由 `composer-config` 的 React 组件渲染；
 * 本文件补齐弹层本体，两侧不再一边 React 一边 legacy。
 *
 * 幂等注册表见 `../composer-portal/mount-store`。
 */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export interface ComposerSkillOption {
  readonly name: string;
  readonly description: string;
  /** 已由 legacy 侧翻译好的来源标签。 */
  readonly sourceLabel: string;
  readonly selected: boolean;
}

export interface ComposerSkillsState {
  readonly loading: boolean;
  readonly options: ReadonlyArray<ComposerSkillOption>;
  readonly selectedCount: number;
}

export interface ComposerSkillsMount extends ComposerSkillsState {
  readonly key: string;
  readonly target: HTMLElement;
  readonly onToggle: (name: string) => void;
}

export interface ComposerSkillsSnapshot extends MountSnapshot<ComposerSkillsMount> {}

function sameOption(a: ComposerSkillOption, b: ComposerSkillOption): boolean {
  return a.name === b.name
    && a.description === b.description
    && a.sourceLabel === b.sourceLabel
    && a.selected === b.selected;
}

/** 回调不参与比较：它每次都是新闭包，但指向模块级稳定函数。 */
function sameMount(a: ComposerSkillsMount, b: ComposerSkillsMount): boolean {
  if (a.target !== b.target) return false;
  if (a.loading !== b.loading || a.selectedCount !== b.selectedCount) return false;
  if (a.options.length !== b.options.length) return false;
  for (let i = 0; i < a.options.length; i += 1) {
    if (!sameOption(a.options[i], b.options[i])) return false;
  }
  return true;
}

export class ComposerSkillsController extends MountStore<ComposerSkillsMount> {
  constructor() {
    super(sameMount);
  }
}

export const composerSkillsController = new ComposerSkillsController();
