import * as React from "react";
import { WandButton } from "./button";
import { WandIcon } from "./icons";
import { WandDropdownMenuItem } from "./dropdown-menu";
import { shareablePageUrl } from "../../page-route";
import { usePageSearch } from "../use-page-route";

/** Same-size, local feedback; never copies login tickets, shell flags or credentials. */
export function CopyPageLink({ label = "复制当前页面链接", menuItem = false }: { label?: string; menuItem?: boolean }): React.ReactElement {
  const search = usePageSearch();
  const [phase, setPhase] = React.useState<"idle" | "pending" | "done" | "failed">("idle");
  React.useEffect(() => setPhase("idle"), [search]);
  const copy = (): void => {
    setPhase("pending");
    void Promise.resolve().then(() => navigator.clipboard.writeText(shareablePageUrl(window.location.href))).then(() => setPhase("done"), () => setPhase("failed"));
  };
  const text = phase === "pending" ? "正在复制…" : phase === "done" ? "链接已复制" : phase === "failed" ? "复制失败，请重试" : label;
  if (menuItem) return <WandDropdownMenuItem icon="copy" aria-label={label} disabled={phase === "pending"} onSelect={copy}>{text}</WandDropdownMenuItem>;
  return <WandButton kind="ghost" size="small" aria-label={label} title={label} disabled={phase === "pending"}
    style={{ minWidth: 144 }} onClick={copy}><WandIcon name="copy" slot="start"/><span aria-live="polite">{text}</span></WandButton>;
}
