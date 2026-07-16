import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function occurrences(contents: string, fragment: string): number {
  return contents.split(fragment).length - 1;
}

test("business overlay hosts and browser bridges are mounted exactly once", () => {
  const host = source("src/web-ui/react/overlay-host.tsx");
  const index = source("src/web-ui/react/index.tsx");
  const main = source("src/web-ui/browser/main.ts");

  for (const component of ["WorktreeMergeHost", "FilePreviewHost", "RestartOverlayHost"]) {
    assert.equal(occurrences(host, `<${component} />`), 1, `${component} must mount once`);
  }
  assert.ok(
    host.indexOf("<RestartOverlayHost />") > host.indexOf("<FilePreviewHost />"),
    "the non-dismissable restart surface must be mounted last",
  );
  for (const globalName of [
    "__wandReactWorktreeMerge",
    "__wandReactFilePreview",
    "__wandReactRestartOverlay",
  ]) {
    assert.equal(occurrences(index, `window.${globalName} =`), 1, `${globalName} must be exposed once`);
  }
  assert.match(main, /installWorktreeMergeLegacyAdapter\s*\(/);
  assert.match(main, /installFilePreviewLegacyAdapter\s*\(/);
});

test("Worktree, File Preview, and restart keep only thin legacy entry points", () => {
  const sessionEngine = source("src/web-ui/browser/session-engine.ts");
  const fileBrowser = source("src/web-ui/browser/file-browser.ts");
  const notifications = source("src/web-ui/browser/notifications.ts");
  const render = source("src/web-ui/browser/render.ts");

  for (const fragment of [
    "renderWorktreeMergeModal",
    "renderWorktreeMergeContent",
    "confirmWorktreeMerge",
    "activeWorktreeMergeSessionId",
    "worktree-merge-modal",
  ]) {
    assert.ok(!sessionEngine.includes(fragment), `session-engine must not restore ${fragment}`);
    assert.ok(!render.includes(fragment), `render must not restore ${fragment}`);
  }
  for (const fragment of [
    "_activeFilePreview",
    "renderPreviewContent",
    "highlightCodePreview",
    "file-preview-overlay",
  ]) {
    assert.ok(!fileBrowser.includes(fragment), `file-browser must not restore ${fragment}`);
  }
  for (const fragment of [
    "startRestartPolling",
    "setRestartTarget",
    "restart-overlay-content",
    'document.getElementById("restart-overlay")',
  ]) {
    assert.ok(!notifications.includes(fragment), `notifications must not restore ${fragment}`);
  }
  assert.match(notifications, /showReactRestart\(previousInstanceId, expectedVersion\)/);
  assert.match(notifications, /showReactAutoUpdate\(currentVer, latestVer, previousInstanceId\)/);
});

test("native back honors generic confirmation, file preview, and non-dismissable restart order", () => {
  const notifications = source("src/web-ui/browser/notifications.ts");
  const start = notifications.indexOf("handleNativeBack = function");
  const end = notifications.indexOf("// ── Notification Sound", start);
  const handler = notifications.slice(start, end);

  const restart = handler.indexOf("restartOverlayController.isOpen()");
  const genericDialog = handler.indexOf("reactOverlay.closeTopmost()");
  const filePreview = handler.indexOf("reactFilePreview.closeTopmost()");
  assert.ok(restart >= 0 && genericDialog > restart && filePreview > genericDialog);
});

test("busy business controllers consume native back without bypassing Host dismissability", () => {
  const notifications = source("src/web-ui/browser/notifications.ts");
  const start = notifications.indexOf("handleNativeBack = function");
  const end = notifications.indexOf("// ── Notification Sound", start);
  const handler = notifications.slice(start, end);

  for (const feature of ["QuickCommit", "NewSession", "FolderPicker", "WorktreeMerge"]) {
    assert.match(handler, new RegExp(`react${feature}\\.closeTopmost\\(\\)`));
  }

  for (const feature of ["new-session", "folder-picker", "quick-commit", "worktree-merge"]) {
    const controller = source(`src/web-ui/react/${feature}/controller.ts`);
    const host = source(`src/web-ui/react/${feature}/host.tsx`);
    assert.match(controller, /if \(!snapshot\.open \|\| !snapshot\.dismissable\) return false;/);
    assert.match(controller, /if \(snapshot\.dismissable\) this\.close\(\);\s+return true;/);
    assert.match(host, /Controller\.setDismissable\(false\)/);
    assert.match(host, /Controller\.setDismissable\(true\)/);
  }
});

test("legacy stylesheet no longer owns migrated business overlays", () => {
  const styles = source("src/web-ui/content/styles.css");
  for (const selector of [
    ".worktree-merge-modal",
    ".file-preview-overlay",
    ".restart-overlay",
    ".wand-mini-toast",
  ]) {
    assert.ok(!styles.includes(selector), `legacy styles must not restore ${selector}`);
  }
  assert.ok(styles.includes(".session-kind-badge.worktree-merge"));
});
