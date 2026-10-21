import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("sidebar copy is object-scoped and the workbar renders no directory label", () => {
  const leading = source("src/web-ui/react/shell/workbar-actions.tsx").split("export function WorkbarLeading")[1];
  assert.doesNotMatch(leading, /workbar-context|topbar\.copy/);
  assert.doesNotMatch(leading, /WandDropdownMenu|chevronDown/);
  const session = source("src/web-ui/react/workspaces/sidebar-session-menu.tsx");
  assert.match(session, /copyTextToPlatformClipboard\(session\.cwd\)/);
  assert.doesNotMatch(session, /topbar\.copy|useUiStoreSnapshot/);
  const native = source("macos/Wand/WorkspaceListView.swift");
  assert.match(native, /DesktopCopyWorkingDirectoryButton\(cwd: session\.cwd\)/);
  assert.match(native, /DesktopCopyWorkingDirectoryButton\(cwd: group\.isGlobal \? nil : group\.workspaceCwd\)/);
  assert.match(source("macos/Wand/SessionSidebarView.swift"), /DesktopCopyWorkingDirectoryButton\(cwd: session\.cwd\)/);
});

test("sidebar directory copy browser: inactive scope, empty, failure/retry, worktree, native and rollback", {
  skip: process.env.WAND_SIDEBAR_CWD_COPY_BROWSER !== "1", timeout: 120_000,
}, () => {
  const result = spawnSync(process.execPath, ["tests/helpers/sidebar-cwd-copy-browser.mjs"], { encoding: "utf8", timeout: 110_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
