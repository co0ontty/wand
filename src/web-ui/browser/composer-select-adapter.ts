import {
  composerSelectController,
  type ComposerSelectControl,
  type ComposerSelectMount,
  type ComposerSelectScope,
} from "../react/composer-select/controller";
import type { WandSelectOption } from "../react/ui";

export interface BrowserComposerSelectDefinition {
  readonly value: string;
  readonly options: ReadonlyArray<WandSelectOption>;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly displayValue?: string;
  readonly disabled?: boolean;
}

export interface BrowserComposerSelectConfig {
  resolve(
    control: ComposerSelectControl,
    scope: ComposerSelectScope,
  ): BrowserComposerSelectDefinition;
  onValueChange(
    control: ComposerSelectControl,
    value: string,
    scope: ComposerSelectScope,
  ): void;
}

function isControl(value: string | undefined): value is ComposerSelectControl {
  return value === "mode" || value === "model" || value === "thinking";
}

function isScope(value: string | undefined): value is ComposerSelectScope {
  return value === "mode" || value === "runtime" || value === "all" || value === "dropdown";
}

export function syncBrowserComposerSelects(config: BrowserComposerSelectConfig): void {
  const mounts: ComposerSelectMount[] = [];
  document.querySelectorAll<HTMLElement>("[data-composer-select-host]").forEach((target, index) => {
    const control = target.dataset.modeControl;
    const scope = target.dataset.composerSelectScope;
    if (!isControl(control) || !isScope(scope) || !target.isConnected) return;
    const definition = config.resolve(control, scope);
    mounts.push({
      key: target.dataset.composerSelectKey || `${scope}-${control}-${index}`,
      target,
      control,
      scope,
      value: definition.value,
      options: definition.options,
      ariaLabel: definition.ariaLabel,
      placeholder: definition.placeholder,
      displayValue: definition.displayValue,
      disabled: definition.disabled,
      align: control === "mode" ? "start" : "end",
      onValueChange(value) {
        config.onValueChange(control, value, scope);
      },
    });
  });
  composerSelectController.sync(mounts);
}
