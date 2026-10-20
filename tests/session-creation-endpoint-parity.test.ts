import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function sources(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path, extension) : path.endsWith(extension) ? [path] : [];
  });
}

// Source contract only: native request tests and real UI acceptance remain separate.
for (const [name, directory, extension] of [
  ["Web", "src/web-ui/browser", ".ts"],
  ["Web React", "src/web-ui/react", ".ts"],
  ["Web React components", "src/web-ui/react", ".tsx"],
  ["Android", "android/app/src/main/java", ".kt"],
  ["iOS", "ios/Wand", ".swift"],
  ["macOS", "macos/Wand", ".swift"],
] as const) {
  test(`${name} has no legacy session creation endpoint literals`, {
    skip: !existsSync(join(root, directory)),
  }, () => {
    for (const path of sources(join(root, directory), extension)) {
      const content = readFileSync(path, "utf8");
      assert.equal(/["'`]\/api\/(?:commands|structured-sessions)["'`]/.test(content), false,
        `${relative(root, path)} still names a removed creation endpoint`);
    }
  });
}

test("Render verification uses unified PTY shell creation", () => {
  for (const script of ["verify-render-e2e.sh", "verify-render-upgrade-e2e.sh"]) {
    const content = readFileSync(join(root, "scripts", script), "utf8");
    assert.match(content, /api\("POST", "\/api\/sessions", \{\s*kind: "pty", shell: true/);
    assert.doesNotMatch(content, /api\("POST", "\/api\/(?:commands|structured-sessions)"/);
  }
});
