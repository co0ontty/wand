export interface ComposerSelectValueOption {
  readonly value: string;
}

export function normalizeComposerModelValue(value: string | null | undefined): string {
  return value === "default" ? "" : (value || "");
}

export function normalizeAvailableComposerValue(
  value: string | null | undefined,
  options: ReadonlyArray<ComposerSelectValueOption>,
  fallback: string,
): string {
  const candidate = value || fallback;
  return options.some((option) => option.value === candidate) ? candidate : fallback;
}

/** 模型目录里的一项：解析展示名只需要 id / label。 */
export interface ComposerModelEntry {
  readonly id: string;
  readonly label?: string;
}

export const MODEL_DEFAULT_VALUE = "default";

/** 「跟随 X 默认」这种没写明模型的文案不算名字，其余去掉「（X 默认）」尾巴后就是 CLI 报出来的默认模型。 */
const GENERIC_DEFAULT_MODEL_LABEL = /^跟随.*默认$/;
const TRAILING_DEFAULT_NOTE = /\s*[（(][^（()）]*默认[^（()）]*[）)]\s*$/;

/**
 * 界面上的模型名（与 React 侧 `wandModelDisplayName` 同口径）：
 * `default` 哨兵与空值都不是模型名，换成真正会用的那个模型——先看服务端为该 CLI 配置的默认模型，
 * 再看 CLI 自己报出来的默认项（Codex / Grok 的目录项里写了具体模型名）。
 * 三处都拿不到名字返回空串，由调用方决定兜底文案。
 */
export function modelDisplayName(
  model: string | null | undefined,
  models: ReadonlyArray<ComposerModelEntry>,
  configuredDefault: string | null | undefined,
): string {
  const id = (model ?? "").trim();
  if (id && id !== MODEL_DEFAULT_VALUE) {
    const match = models.find((item) => item.id === id);
    return (match?.label ?? "").trim() || id;
  }
  const configured = (configuredDefault ?? "").trim();
  if (configured && configured !== MODEL_DEFAULT_VALUE) {
    const match = models.find((item) => item.id === configured);
    return (match?.label ?? "").trim() || configured;
  }
  const entry = (models.find((item) => item.id === MODEL_DEFAULT_VALUE)?.label ?? "").trim();
  const stripped = entry.replace(TRAILING_DEFAULT_NOTE, "").trim();
  return GENERIC_DEFAULT_MODEL_LABEL.test(stripped) ? "" : stripped;
}
