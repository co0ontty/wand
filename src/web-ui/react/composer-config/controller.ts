/**
 * 组合器三件套（模式 / 模型 / 思考）chip 的 portal 渲染契约。
 *
 * 旧的 `renderComposerConfigControlsHtml` 一次性吐出整块 markup，之后由
 * `refreshComposerConfigControls` 用 `querySelector` + `insertAdjacentHTML`
 * 增量改写。现在 chip 结构由 React 渲染，legacy 只负责把「值 + 可见性 + 回调」
 * 发布给这里，所以 markup 与状态更新都不会再分叉。
 *
 * 幂等注册表本身见 `../composer-portal/mount-store`。
 */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export type ComposerConfigScope = "mode" | "runtime" | "all";

export interface ComposerConfigState {
  /** 外层 `title`：三个 chip 的完整值的组合。 */
  readonly groupTitle: string;
  readonly modeLabel: string;
  readonly modelFullLabel: string;
  readonly modelRefreshing: boolean;
  readonly thinkingValue: string;
  readonly thinkingLabel: string;
  readonly skillsVisible: boolean;
  readonly skillsLabel: string;
  readonly skillsTitle: string;
  readonly skillsExpanded: boolean;
}

export interface ComposerConfigMount extends ComposerConfigState {
  readonly key: string;
  readonly target: HTMLElement;
  readonly scope: ComposerConfigScope;
  readonly onRefreshModels: () => void;
  readonly onOpenSkills: (trigger: HTMLButtonElement) => void;
}

export interface ComposerConfigSnapshot extends MountSnapshot<ComposerConfigMount> {}

function sameState(a: ComposerConfigState, b: ComposerConfigState): boolean {
  return a.groupTitle === b.groupTitle
    && a.modeLabel === b.modeLabel
    && a.modelFullLabel === b.modelFullLabel
    && a.modelRefreshing === b.modelRefreshing
    && a.thinkingValue === b.thinkingValue
    && a.thinkingLabel === b.thinkingLabel
    && a.skillsVisible === b.skillsVisible
    && a.skillsLabel === b.skillsLabel
    && a.skillsTitle === b.skillsTitle
    && a.skillsExpanded === b.skillsExpanded;
}

/**
 * 回调不参与比较：它每次都是新闭包，但捕获的都是模块级稳定函数。
 * 比较它会让每次 `render()` 都广播一次，chip 与 select 会无谓重挂载。
 */
function sameMount(a: ComposerConfigMount, b: ComposerConfigMount): boolean {
  return a.target === b.target && a.scope === b.scope && sameState(a, b);
}

export class ComposerConfigController extends MountStore<ComposerConfigMount> {
  constructor() {
    super(sameMount);
  }
}

export const composerConfigController = new ComposerConfigController();
