import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reactRoot = path.join(root, "src", "web-ui", "react");

interface SourceFile {
  relativePath: string;
  source: string;
}

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function collectSourceFiles(directory: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(absolutePath));
      continue;
    }
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    files.push({
      relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
      source: readFileSync(absolutePath, "utf8"),
    });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function assertNoViolations(rule: string, violations: string[]): void {
  assert.equal(
    violations.length,
    0,
    `${rule}\n${violations.map((violation) => `  - ${violation}`).join("\n")}`,
  );
}

function lineNumber(contents: string, offset: number): number {
  return contents.slice(0, offset).split("\n").length;
}

/**
 * Masks comments and string bodies while preserving newlines and character
 * offsets. Architecture checks can then report useful line numbers without
 * treating documentation or JSX string props as executable DOM/network calls.
 */
function maskNonCode(contents: string): string {
  let result = "";
  let state: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" = "code";
  let escaped = false;

  for (let index = 0; index < contents.length; index += 1) {
    const current = contents[index];
    const next = contents[index + 1];

    if (state === "code") {
      if (current === "/" && next === "/") {
        result += "  ";
        index += 1;
        state = "line-comment";
      } else if (current === "/" && next === "*") {
        result += "  ";
        index += 1;
        state = "block-comment";
      } else if (current === "'") {
        result += " ";
        state = "single";
        escaped = false;
      } else if (current === '"') {
        result += " ";
        state = "double";
        escaped = false;
      } else if (current === "`") {
        result += " ";
        state = "template";
        escaped = false;
      } else {
        result += current;
      }
      continue;
    }

    if (state === "line-comment") {
      if (current === "\n") {
        result += "\n";
        state = "code";
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }

    result += current === "\n" ? "\n" : " ";
    if (escaped) {
      escaped = false;
    } else if (current === "\\") {
      escaped = true;
    } else if (
      (state === "single" && current === "'")
      || (state === "double" && current === '"')
      || (state === "template" && current === "`")
    ) {
      state = "code";
    }
  }

  return result;
}

function importedSpecifiers(contents: string): Array<{ specifier: string; offset: number }> {
  const imports: Array<{ specifier: string; offset: number }> = [];
  const pattern = /\b(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;
  for (const match of contents.matchAll(pattern)) {
    imports.push({ specifier: match[1], offset: match.index ?? 0 });
  }
  return imports;
}

function isUiInfrastructure(relativePath: string): boolean {
  return relativePath.startsWith("src/web-ui/react/ui/")
    || relativePath.startsWith("src/web-ui/react/styles/")
    || relativePath === "src/web-ui/react/index.tsx"
    || relativePath === "src/web-ui/react/styles.ts";
}

function isRepositoryOrPlatformAdapter(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  return segments.some((segment) => /^(?:repositories|repository|platforms|platform|adapters|adapter)$/.test(segment))
    || /(?:^|[-.])(?:repository|platform|adapter)(?:[-.]|$)/.test(basename);
}

function globMatches(glob: string, candidate: string): boolean {
  const normalized = glob.replace(/^\.\//, "").split(path.sep).join("/");
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (current === "*" && next === "*" && afterNext === "/") {
      expression += "(?:.*/)?";
      index += 2;
    } else if (current === "*" && next === "*") {
      expression += ".*";
      index += 1;
    } else if (current === "*") {
      expression += "[^/]*";
    } else if (current === "?") {
      expression += "[^/]";
    } else {
      expression += current.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(candidate);
}

test("Radix primitives stay behind src/web-ui/react/ui wrappers", () => {
  const violations: string[] = [];
  for (const file of collectSourceFiles(reactRoot)) {
    for (const imported of importedSpecifiers(file.source)) {
      if (!imported.specifier.startsWith("@radix-ui/")) continue;
      if (file.relativePath.startsWith("src/web-ui/react/ui/")) continue;
      violations.push(
        `${file.relativePath}:${lineNumber(file.source, imported.offset)} imports ${imported.specifier}`,
      );
    }
  }
  assertNoViolations("Only src/web-ui/react/ui/** may import @radix-ui/* directly.", violations);
});

test("React business modules do not reach through legacy DOM or state seams", () => {
  const violations: string[] = [];
  const forbiddenDom = [
    { label: "innerHTML", pattern: /\.\s*innerHTML\b/g },
    { label: "dangerouslySetInnerHTML", pattern: /\bdangerouslySetInnerHTML\s*=/g },
    { label: "insertAdjacentHTML", pattern: /\.\s*insertAdjacentHTML\s*\(/g },
    {
      label: "getElementById/querySelector",
      pattern: /\.\s*(?:getElementById|querySelector(?:All)?)\s*(?:<[^>\n]*>)?\s*\(/g,
    },
  ];

  for (const file of collectSourceFiles(reactRoot)) {
    if (!isUiInfrastructure(file.relativePath)) {
      const executable = maskNonCode(file.source);
      for (const rule of forbiddenDom) {
        for (const match of executable.matchAll(rule.pattern)) {
          violations.push(
            `${file.relativePath}:${lineNumber(executable, match.index ?? 0)} uses ${rule.label}`,
          );
        }
      }
    }

  }

  assertNoViolations(
    "React business modules must use React state, refs, and adapters instead of legacy DOM/state seams.",
    violations,
  );
});

test("React modules consume legacy behavior only through installed runtime interfaces", () => {
  const violations: string[] = [];
  for (const file of collectSourceFiles(reactRoot)) {
    for (const imported of importedSpecifiers(file.source)) {
      const normalized = imported.specifier.replace(/\.(?:[cm]?[jt]sx?)$/, "");
      if (!/(?:^|\/)browser\//.test(normalized)) continue;
      violations.push(
        `${file.relativePath}:${lineNumber(file.source, imported.offset)} imports legacy ${imported.specifier}`,
      );
    }
  }
  assertNoViolations(
    "React modules must use controller/runtime interfaces; browser/** implementation imports are forbidden.",
    violations,
  );
});

test("shell state boundary does not re-enter render or websocket modules", () => {
  const stateSource = readFileSync(path.join(root, "src", "web-ui", "browser", "state.ts"), "utf8");
  assert.doesNotMatch(stateSource, /^import\s+(?!type\b)/m);
});

test("fetch and WandNative access stay inside repository or platform adapter boundaries", () => {
  const violations: string[] = [];
  const forbiddenBoundaryCalls = [
    { label: "fetch", pattern: /\bfetch\s*\(/g },
    { label: "WandNative", pattern: /\bWandNative\b/g },
  ];

  for (const file of collectSourceFiles(reactRoot)) {
    if (isRepositoryOrPlatformAdapter(file.relativePath)) continue;
    const executable = maskNonCode(file.source);
    for (const rule of forbiddenBoundaryCalls) {
      for (const match of executable.matchAll(rule.pattern)) {
        violations.push(
          `${file.relativePath}:${lineNumber(executable, match.index ?? 0)} accesses ${rule.label}`,
        );
      }
    }
  }

  assertNoViolations(
    "Direct network/native access requires a *repository*, *platform*, or *adapter* module boundary.",
    violations,
  );
});

test("the React overlay root is a sibling after the legacy app root", () => {
  const contents = source("src/web-ui/index.ts");
  const appOpen = contents.indexOf('<div id="app"');
  const appClose = appOpen < 0 ? -1 : contents.indexOf("</div>", appOpen);
  const overlayOpen = contents.indexOf('<div id="overlay-root"');

  assert.ok(appOpen >= 0, "src/web-ui/index.ts must contain #app");
  assert.ok(appClose > appOpen, "src/web-ui/index.ts must close #app");
  assert.ok(
    overlayOpen > appClose,
    "src/web-ui/index.ts must place #overlay-root outside and after the closed #app element",
  );
  assert.match(
    contents.slice(overlayOpen, contents.indexOf(">", overlayOpen) + 1),
    /\bdata-wand-ui-root\b/,
    "src/web-ui/index.ts must preserve the React overlay-root marker",
  );
});

test("migrated dialogs and toasts have no hand-written DOM implementation", () => {
  const notifications = source("src/web-ui/browser/notifications.ts");
  const styles = source("src/web-ui/content/styles.css");
  const forbiddenSource = [
    "_wandDialogStack",
    "openLegacyWandDialog",
    "wand-dialog-backdrop",
    "toast-message",
  ];

  for (const fragment of forbiddenSource) {
    assert.ok(
      !notifications.includes(fragment),
      `notifications.ts must not restore legacy ${fragment}`,
    );
    assert.ok(
      !styles.includes(fragment),
      `styles.css must not restore legacy ${fragment}`,
    );
  }
});

test("React browser sources are included only in the browser TypeScript program", () => {
  const browserConfig = JSON.parse(source("tsconfig.browser.json")) as { include?: string[] };
  const serverConfig = JSON.parse(source("tsconfig.json")) as { exclude?: string[] };
  const browserIncludes = browserConfig.include ?? [];
  const serverExcludes = serverConfig.exclude ?? [];
  const probes = [
    "src/web-ui/react/__architecture_probe__.ts",
    "src/web-ui/react/nested/__architecture_probe__.tsx",
  ];

  for (const probe of probes) {
    assert.ok(
      browserIncludes.some((glob) => globMatches(glob, probe)),
      `tsconfig.browser.json include must cover ${probe}`,
    );
    assert.ok(
      serverExcludes.some((glob) => globMatches(glob, probe)),
      `tsconfig.json exclude must cover ${probe}`,
    );
  }
});

test("React sources have an independent strict TypeScript gate", () => {
  const reactConfig = JSON.parse(source("tsconfig.react.json")) as {
    compilerOptions?: { strict?: boolean; noImplicitAny?: boolean };
    include?: string[];
  };
  const packageJson = JSON.parse(source("package.json")) as { scripts?: Record<string, string> };
  assert.equal(reactConfig.compilerOptions?.strict, true);
  assert.equal(reactConfig.compilerOptions?.noImplicitAny, true);
  assert.ok(
    (reactConfig.include ?? []).some((glob) => globMatches(glob, "src/web-ui/react/nested/probe.tsx")),
    "tsconfig.react.json must include every React TSX module",
  );
  assert.match(
    packageJson.scripts?.check ?? "",
    /tsconfig\.react\.json/,
    "npm run check must execute the strict React TypeScript project",
  );
});

test("React style installation keeps foundation and business layers behind one interface", () => {
  const installer = source("src/web-ui/react/styles.ts");
  const foundation = source("src/web-ui/react/styles/base.ts");
  const features = source("src/web-ui/react/styles/features.ts");

  assert.match(installer, /export function installReactUiStyles/);
  assert.match(installer, /style\.textContent = reactUiStyles/);
  assert.ok(!installer.includes(".wand-ui-"), "styles.ts must remain an installer, not a CSS owner");
  assert.ok(!installer.includes(".wand-settings-"), "styles.ts must not absorb feature CSS");
  assert.ok(foundation.includes(".wand-ui-button"));
  assert.ok(foundation.includes("@media (prefers-reduced-motion: reduce)"));
  assert.ok(!foundation.includes(".wand-settings-"));
  assert.ok(!foundation.includes(".wand-quick-"));
  assert.ok(features.includes(".wand-settings-dialog"));
  assert.ok(features.includes(".wand-quick-dialog"));
  assert.ok(features.includes(".wand-new-session-dialog"));
  assert.ok(features.includes(".wand-folder-picker-dialog"));
  assert.ok(features.includes(".wand-worktree-dialog"));

  const cascade = [
    "foundationStyles",
    "settingsAndQuickCommitStyles",
    "sharedMotionStyles",
    "sessionPickerAndWorktreeStyles",
    "reducedMotionStyles",
  ];
  const cascadeSource = installer.slice(installer.indexOf("const reactUiStyles"));
  for (let index = 1; index < cascade.length; index += 1) {
    assert.ok(
      cascadeSource.indexOf(cascade[index - 1]) < cascadeSource.indexOf(cascade[index]),
      `${cascade[index - 1]} must precede ${cascade[index]} in the installed cascade`,
    );
  }
});

test("migrated feature overlays do not restore legacy selectors", () => {
  const styles = source("src/web-ui/content/styles.css");
  for (const selector of [
    ".settings-",
    ".quick-commit-modal",
    ".qc-",
    ".folder-picker-compact",
    ".folder-picker-modal",
    ".worktree-merge-modal",
    ".worktree-merge-content",
    ".worktree-merge-row",
    ".worktree-merge-actions",
    ".file-preview-overlay",
    ".code-preview-",
    ".markdown-preview",
    ".image-preview-",
    ".pdf-preview-",
    ".media-preview-",
    ".binary-preview-",
    ".code-editor-",
    ".wand-mini-toast",
    ".restart-overlay",
    ".session-modal",
    ".mode-cards",
    ".mode-card",
    ".suggestions",
    ".recent-path-bubble",
    ".tool-card",
  ]) {
    assert.ok(!styles.includes(selector), `styles.css must not restore legacy ${selector}`);
  }
  assert.ok(
    styles.includes(".session-kind-badge.worktree-merge"),
    "legacy Shell must retain the Worktree status badge presentation",
  );
});

test("migrated Worktree, File Preview, and Restart overlays keep only browser adapters", () => {
  const browserRoot = path.join(root, "src", "web-ui", "browser");
  const forbidden = ["_activeFilePreview", "renderWorktreeMergeModal", "startRestartPolling"];
  const violations: string[] = [];
  for (const file of collectSourceFiles(browserRoot)) {
    for (const fragment of forbidden) {
      if (file.source.includes(fragment)) violations.push(`${file.relativePath} contains ${fragment}`);
    }
  }
  assertNoViolations("Migrated overlays must not restore their browser DOM implementations.", violations);

  const main = source("src/web-ui/browser/main.ts");
  const notifications = source("src/web-ui/browser/notifications.ts");
  const overlayHost = source("src/web-ui/react/overlay-host.tsx");
  const reactIndex = source("src/web-ui/react/index.tsx");
  for (const fragment of [
    "installWorktreeMergeLegacyAdapter",
    "installFilePreviewLegacyAdapter",
    'import "./notifications"',
  ]) {
    assert.ok(main.includes(fragment), `main.ts must retain the ${fragment} bridge`);
  }
  for (const fragment of ["showReactRestart", "showReactAutoUpdate", "restartOverlayController"]) {
    assert.ok(notifications.includes(fragment), `notifications.ts must retain the ${fragment} bridge`);
  }
  for (const host of ["WorktreeMergeHost", "FilePreviewHost", "RestartOverlayHost"]) {
    assert.ok(overlayHost.includes(`import { ${host} }`), `OverlayHost must import ${host}`);
    assert.ok(overlayHost.includes(`<${host} />`), `OverlayHost must mount ${host}`);
  }
  for (const controller of [
    "__wandReactWorktreeMerge",
    "__wandReactFilePreview",
    "__wandReactRestartOverlay",
  ]) {
    assert.ok(reactIndex.includes(controller), `React index must publish ${controller}`);
  }
});

test("config-path injection and embedded web-asset fallbacks remain intact", () => {
  const contracts: Array<[string, string[]]> = [
    ["src/web-ui/browser/state.ts", ['export var configPath = "${escapeHtml(configPath)}";']],
    [
      "src/web-ui/scripts.ts",
      [
        "EMBEDDED_WEB_ASSETS.scriptsJs",
        'replace("${escapeHtml(configPath)}", escapeHtml(configPath))',
      ],
    ],
    ["src/web-ui/styles.ts", ["EMBEDDED_WEB_ASSETS.stylesCss"]],
    ["src/web-ui/index.ts", ["getScriptContent(configPath)"]],
    [
      "scripts/generate-web-assets.js",
      [
        '["scriptsJs", "scripts.js", "application/javascript"]',
        '["stylesCss", "styles.css", "text/css; charset=utf-8"]',
      ],
    ],
    ["src/web-ui/content/scripts.js", ['"${escapeHtml(configPath)}"']],
  ];
  const violations: string[] = [];

  for (const [relativePath, expectedFragments] of contracts) {
    const contents = source(relativePath);
    for (const fragment of expectedFragments) {
      if (!contents.includes(fragment)) {
        violations.push(`${relativePath} is missing ${JSON.stringify(fragment)}`);
      }
    }
  }

  assertNoViolations(
    "The configPath placeholder and embedded scripts/styles fallback are packaged runtime contracts.",
    violations,
  );
});
