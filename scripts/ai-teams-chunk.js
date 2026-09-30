// AI 团队页 + 任务运行面板打成单独的按需脚本 content/ai-teams.js，不进内联的 scripts.js
// （check-bundle-budget.js 第 5 条）。chunk 自己只带 CHUNK_FILES 与它们引用的纯数据模块；
// 引到 src/web-ui 其余模块和 react 的一律改成向主包要（globalThis.__wandAiTeamsHost），
// 否则 taskBoardController、仓储、React 都会多出一份互不相通的实例。主包侧的注册表在
// src/web-ui/react/ai-teams/lazy.tsx，名字是否齐全由 tests/web-ui-ai-teams.test.ts 静态核对。
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_UI_ROOT = path.join(root, "src", "web-ui");
const REACT_ROOT = path.join(WEB_UI_ROOT, "react");

export const AI_TEAMS_CHUNK_ENTRY = path.join(REACT_ROOT, "ai-teams", "chunk-entry.ts");
export const AI_TEAMS_CHUNK_OUTFILE = path.join(WEB_UI_ROOT, "content", "ai-teams.js");

const CHUNK_FILES = new Set([
  AI_TEAMS_CHUNK_ENTRY,
  path.join(REACT_ROOT, "ai-teams", "teams-page.tsx"),
  path.join(REACT_ROOT, "ai-teams", "team-chat-view.tsx"),
  path.join(REACT_ROOT, "ai-teams", "team-chat-page.tsx"),
  path.join(REACT_ROOT, "ai-teams", "styles.ts"),
  path.join(REACT_ROOT, "issues", "team-run-panel.tsx"),
  path.join(REACT_ROOT, "agents", "candidate-list.ts"),
  path.join(REACT_ROOT, "agents", "candidate-editor.tsx"),
  path.join(REACT_ROOT, "agents", "employee-avatar.tsx"),
  path.join(REACT_ROOT, "agents", "employee-card.tsx"),
  path.join(REACT_ROOT, "agents", "employee-create-form.tsx"),
  path.join(REACT_ROOT, "agents", "employee-list-page.tsx"),
]);
const HOST_PACKAGES = new Set(["react", "react/jsx-runtime"]);
const HOST_NAMESPACE = "wand-ai-teams-host";

/** 主包注册表的键：相对 src/web-ui/react、去扩展名、去 /index。 */
export function aiTeamsHostKey(file) {
  return path.relative(REACT_ROOT, file).split(path.sep).join("/")
    .replace(/\.(ts|tsx)$/, "")
    .replace(/\/index$/, "");
}

export function createAiTeamsHostPlugin() {
  return {
    name: "wand-ai-teams-host",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point" || args.pluginData?.aiTeamsHostProbe) return undefined;
        if (HOST_PACKAGES.has(args.path)) return { path: args.path, namespace: HOST_NAMESPACE };
        if (!args.path.startsWith(".")) {
          return { errors: [{ text: `ai-teams chunk 不能自带第三方包 ${args.path}，请经主包注册表共享` }] };
        }
        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { aiTeamsHostProbe: true },
        });
        if (resolved.errors.length) return { errors: resolved.errors };
        const file = resolved.path;
        if (CHUNK_FILES.has(file) || !file.startsWith(REACT_ROOT + path.sep)) {
          if (file.startsWith(WEB_UI_ROOT + path.sep) && !CHUNK_FILES.has(file)) {
            return { errors: [{ text: `ai-teams chunk 引到了 react 目录外的浏览器模块 ${file}` }] };
          }
          return { path: file };
        }
        return { path: aiTeamsHostKey(file), namespace: HOST_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: HOST_NAMESPACE }, (args) => ({
        contents: `module.exports = globalThis.__wandAiTeamsHost(${JSON.stringify(args.path)});`,
        loader: "js",
      }));
    },
  };
}
