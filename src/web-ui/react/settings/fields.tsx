import type { ReactNode } from "react";
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
}: {
  id: string;
  ariaLabel: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return (
    <div id={id} className="wand-settings-select">
      <WandSelect
      ariaLabel={ariaLabel}
      value={value}
      options={options}
      disabled={disabled}
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

export function SettingsSaveBar({
  label,
  pending,
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
  return (
    <div className="wand-settings-save-bar">
      <SettingsStatus tone={tone}>{status}</SettingsStatus>
      <WandButton kind="primary" disabled={disabled || pending} onClick={onSave}>
        {pending ? "保存中…" : label}
      </WandButton>
    </div>
  );
}

export function SettingsActionButton({
  children,
  pending,
  ...props
}: React.ComponentProps<typeof WandButton> & { pending?: boolean }) {
  return (
    <WandButton {...props} disabled={props.disabled || pending}>
      {pending ? "处理中…" : children}
    </WandButton>
  );
}
