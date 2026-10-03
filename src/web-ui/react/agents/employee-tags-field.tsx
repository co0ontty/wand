import * as React from "react";
import { SILICON_EMPLOYEE_MAX_TAGS, SILICON_EMPLOYEE_TAG_MAX_CHARS } from "../../../ai-team-types.js";

export function EmployeeTagsField({
  id, value, disabled, onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}): React.ReactElement {
  return (
    <div className="wand-settings-field">
      <label className="wand-settings-label" htmlFor={id}>标签</label>
      <input
        id={id}
        type="text"
        className="wand-settings-input"
        value={value}
        placeholder="例如：开发、测试、设计（用逗号分隔）"
        aria-describedby={`${id}-hint`}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-hint`} className="wand-employee-hint">
        最多 {SILICON_EMPLOYEE_MAX_TAGS} 个，每个 {SILICON_EMPLOYEE_TAG_MAX_CHARS} 字；
        「系统用户」「默认用户」由系统保留，不能自定义。
      </p>
    </div>
  );
}
