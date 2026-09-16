import { syncPortalMounts } from "./mount-sync";
import {
  composerSkillsController,
  type ComposerSkillOption,
  type ComposerSkillsMount,
} from "../react/composer-skills/controller";

export interface BrowserComposerSkillsConfig {
  /** 弹层是否打开；关闭时不发布 mount（不渲染）。 */
  visible: boolean;
  loading: boolean;
  options: ReadonlyArray<ComposerSkillOption>;
  selectedCount: number;
  onToggle(name: string): void;
}

/**
 * 把 Skills 弹层状态发布给 React。宿主常驻在加号 popover 之后（与旧的
 * `insertAdjacentElement("afterend")` 落点一致），关闭时不发布 mount。
 */
export function syncBrowserComposerSkills(config: BrowserComposerSkillsConfig): void {
  syncPortalMounts<ComposerSkillsMount>({
    selector: "[data-composer-skills-host]",
    store: composerSkillsController,
    flush: true,
    build(target) {
      if (!config.visible) return null;
      return {
        key: "composer-skills",
        target,
        loading: config.loading,
        options: config.options,
        selectedCount: config.selectedCount,
        onToggle: config.onToggle,
      };
    },
  });
}
