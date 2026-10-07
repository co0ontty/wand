import * as React from "react";
import { Input } from "antd";
import { SILICON_EMPLOYEE_MAX_TAGS, SILICON_EMPLOYEE_TAG_MAX_CHARS } from "../../../ai-team-types.js";
import { SettingsField } from "../settings/fields.js";

/** 标签仍是自由文本输入：解析与上限由 `parseSiliconEmployeeTagInput` 裁决，控件走通用输入框外观。 */
export function EmployeeTagsField({
  id, value, disabled, onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}): React.ReactElement {
  return (
    <SettingsField
      label="标签"
      htmlFor={id}
      hint={`最多 ${SILICON_EMPLOYEE_MAX_TAGS} 个，每个 ${SILICON_EMPLOYEE_TAG_MAX_CHARS} 字；「系统用户」「默认用户」由系统保留，不能自定义。`}
    >
      <Input
        id={id}
        value={value}
        placeholder="例如：开发、测试、设计（用逗号分隔）"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </SettingsField>
  );
}
