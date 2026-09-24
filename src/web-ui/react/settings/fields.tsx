import { useEffect, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { WandButton, WandSelect, WandSwitch } from "../ui";

export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="wand-settings-section">
      <div className="wand-settings-section-heading">
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {action ? <div className="wand-settings-section-action">{action}</div> : null}
      </div>
      <div className="wand-settings-section-body">{children}</div>
    </section>
  );
}

export function SettingsGrid({ children }: { children: ReactNode }) {
  return <div className="wand-settings-grid">{children}</div>;
}

export function SettingsField({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="wand-settings-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="wand-settings-field-error">{error}</span> : null}
      {!error && hint ? <span className="wand-settings-field-hint">{hint}</span> : null}
    </div>
  );
}

export function SettingsTextInput({
  id,
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
  invalid,
  autoComplete,
  min,
  max,
  list,
}: {
  id: string;
  value: string | number;
  onChange(value: string): void;
  type?: "text" | "number" | "url" | "password" | "search";
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoComplete?: string;
  min?: number;
  max?: number;
  list?: string;
}) {
  return (
    <input
      id={id}
      className="wand-settings-input"
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      autoComplete={autoComplete}
      min={min}
      max={max}
      list={list}
      spellCheck={false}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

export function SettingsSelect({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  disabled,
  searchable,
  searchPlaceholder,
}: {
  id: string;
  ariaLabel: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  return (
    <div id={id} className="wand-settings-select">
      <WandSelect
      ariaLabel={ariaLabel}
      value={value}
      options={options}
      disabled={disabled}
      searchable={searchable}
      searchPlaceholder={searchPlaceholder}
      onValueChange={onChange}
      />
    </div>
  );
}

export function SettingsToggle({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
}) {
  return (
    <div className="wand-settings-toggle-row">
      <div>
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      <WandSwitch
        ariaLabel={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function SettingsStatus({
  children,
  tone = "info",
}: {
  children?: ReactNode;
  tone?: "info" | "success" | "warning" | "error";
}) {
  if (!children) return null;
  return (
    <div className={`wand-settings-status wand-settings-status-${tone}`} role="status" aria-live="polite">
      {children}
    </div>
  );
}

type ActionSettlement = "success" | "error" | null;

function useActionFlash(
  pending: boolean,
  settled: ActionSettlement,
): "success" | "error" | null {
  const [flash, setFlash] = useState<"success" | "error" | null>(null);
  const wasPending = useRef(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      setFlash(null);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      return;
    }
    if (!wasPending.current || (settled !== "success" && settled !== "error")) return;
    wasPending.current = false;
    setFlash(settled);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setFlash(null);
    }, 1400);
  }, [pending, settled]);
  return flash;
}

export function SettingsSaveBar({
  label,
  pending = false,
  disabled,
  onSave,
  status,
  tone,
}: {
  label: string;
  pending?: boolean;
  disabled?: boolean;
  onSave(): void;
  status?: ReactNode;
  tone?: "info" | "success" | "warning" | "error";
}) {
  const settled: ActionSettlement = tone === "error"
    ? "error"
    : tone === "success" || tone === "warning"
      ? "success"
      : null;
  return (
    <div className="wand-settings-save-bar">
      <SettingsStatus tone={tone}>{status}</SettingsStatus>
      <SettingsActionButton
        kind="primary"
        pending={pending}
        settled={settled}
        disabled={disabled}
        pendingLabel="保存中…"
        successLabel="已保存"
        errorLabel="保存失败"
        onClick={onSave}
      >
        {label}
      </SettingsActionButton>
    </div>
  );
}

export function SettingsActionButton({
  children,
  pending = false,
  settled = null,
  pendingLabel = "处理中…",
  successLabel = "已完成",
  errorLabel = "失败",
  onClick,
  disabled,
  ...props
}: Omit<ComponentProps<typeof WandButton>, "onClick"> & {
  pending?: boolean;
  settled?: ActionSettlement;
  pendingLabel?: ReactNode;
  successLabel?: ReactNode;
  errorLabel?: ReactNode;
  onClick?(event: MouseEvent<HTMLButtonElement>): void | boolean | Promise<void | boolean>;
}) {
  const settledFlash = useActionFlash(pending, settled);
  const [clickFlash, setClickFlash] = useState<"success" | "error" | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const flash = clickFlash ?? settledFlash;
  const arm = (next: "success" | "error"): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setClickFlash(next);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setClickFlash(null);
    }, 1400);
  };
  return (
    <WandButton
      {...props}
      aria-busy={pending || undefined}
      aria-live="polite"
      disabled={disabled || pending || flash === "success"}
      onClick={onClick ? async (event) => {
        try {
          const result = await onClick(event);
          if (result === false) arm("error");
          else if (result === true) arm("success");
        } catch {
          arm("error");
        }
      } : undefined}
    >
      {pending ? pendingLabel : flash === "success" ? successLabel : flash === "error" ? errorLabel : children}
    </WandButton>
  );
}
