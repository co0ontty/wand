import * as React from "react";
import { WandTabs } from "../ui";
import { newSessionController, type NewSessionOpenOptions } from "./controller";

/** Both actions stay in the same new-work page and retain the owning composer draft. */
export function NewWorkIntent({ task, options, disabled }: {
  task: boolean; options: NewSessionOpenOptions; disabled?: boolean;
}) {
  return <WandTabs ariaLabel="新建工作方式" value={task ? "task" : "work"}
    onValueChange={value => newSessionController.open({ ...options, newTask: value === "task" })}
    tabs={[
      { value: "work", label: "开始工作", content: null, disabled },
      { value: "task", label: "创建任务", content: null, disabled },
    ]}/>;
}
