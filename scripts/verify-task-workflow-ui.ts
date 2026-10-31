// Loopback production-component preflight. NOT installed-service acceptance.
// Temporary isolated storage, no real employees/models, no production credentials.
import express from "express";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WandStorage } from "../src/storage.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { jsonErrorHandler } from "../src/express-async.js";
const root = resolve(import.meta.dirname, ".."), directory = mkdtempSync(join(tmpdir(), "wand-workflow-ui-"));
const output = join(root, "output/task-workflow-implementation"); mkdirSync(output, { recursive: true });
const storage = new WandStorage(join(directory, "wand.db"));
const workspace = storage.createWorkspace({ name: "隔离验收项目", cwd: directory });
const flow = storage.createWandTask({ title: "隔离验收闭环任务", description: "验证真实界面与真实接口流转；不启动模型、不触碰生产数据。", status: "doing", workspaceId: workspace.id });
const ready = storage.createWandTask({ title: "等待人工确认的交付", status: "doing", workspaceId: workspace.id });
const archived = storage.createWandTask({ title: "已确认归档的交付", status: "doing", workspaceId: workspace.id });
const legacy = storage.createWandTask({ title: "历史状态待核对", status: "done", workspaceId: workspace.id });
const child = storage.createWandTask({ title: "可检索的独立子目标", status: "doing", parentTaskId: flow.id, workspaceId: workspace.id });
for (const [task, actions] of [[ready, ["submit", "pass"]], [archived, ["submit", "pass", "accept"]], [child, ["submit", "pass", "accept"]]] as const) {
  for (const action of actions) storage.applyTaskWorkflow(task.id, { action, requestId: randomUUID(), expectedUpdatedAt: storage.getWandTask(task.id)!.updatedAt, evidence: "隔离夹具已核对的证据", blocker: "" }, { kind: "user" });
}
const app = express(), writes: Array<{ method: string; path: string }> = [];
app.use(express.json());
app.use((req, _res, next) => { if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) writes.push({ method: req.method, path: req.path }); next(); });
registerTaskRoutes(app, { storage });
app.get("/api/silicon-employees", (_req, res) => res.json({ employees: [] }));
app.get("/api/ai-teams", (_req, res) => res.json([]));
app.get("/api/session-check", (_req, res) => res.json({ authed: true }));
app.get("/fixture-facts", (_req, res) => res.json({ tasks: storage.listWandTasks(), writes, modelCalls: 0 }));
await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import React from "react"; import {createRoot} from "react-dom/client";
import {WandUiProvider} from "./src/web-ui/react/theme";
import {TaskBoardHost} from "./src/web-ui/react/issues/task-board-host";
import {taskBoardController} from "./src/web-ui/react/issues/task-board-controller";
import {taskBoardRepository} from "./src/web-ui/react/issues/task-board-repository";
import {PortalContainerProvider} from "./src/web-ui/react/ui";
import {installReactUiStyles} from "./src/web-ui/react/styles";
installReactUiStyles(); window.__wandAiTeamsChunk={TaskTeamRunPanel:()=>null};
Object.assign(taskBoardRepository,{workspaces:async()=>${JSON.stringify([workspace])},models:async()=>({models:[]}),agentDefaults:async()=>({provider:"pi",model:"default",thinkingEffort:"off",mode:"default",kind:"structured"})});
taskBoardController.open();createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}><WandUiProvider><TaskBoardHost/></WandUiProvider></PortalContainerProvider>);
` }, outfile: join(directory, "app.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
app.get("/app.js", (_req, res) => res.type("text/javascript").send(readFileSync(join(directory, "app.js"))));
app.get("/styles.css", (_req, res) => res.type("text/css").send(readFileSync(join(root, "src/web-ui/content/styles.css"))));
app.get("/", (_req, res) => res.type("html").send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离生产组件验收</title><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><div id="portals" data-wand-ui-root></div><script src="/app.js"></script></body></html>'));
app.use(jsonErrorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolveListen => server.once("listening", resolveListen));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const sourceFiles = ["src/task-types.ts", "src/task-workflow.ts", "src/storage/tasks-repository.ts", "src/storage/task-workflow-repository.ts", "src/server-task-routes.ts", "src/web-ui/react/issues/task-board-host.tsx", "src/web-ui/react/issues/task-board-views.tsx", "src/web-ui/react/issues/task-acceptance.tsx", "src/web-ui/react/ui/stretch-tabs.tsx", "src/web-ui/content/styles.css"];
const sourceFingerprints = Object.fromEntries(sourceFiles.map(path => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]));
writeFileSync(join(output, "ui-fixture.json"), JSON.stringify({ origin, scope: "isolated production components + real routes, not installed acceptance", sourceFingerprints, taskIds: { flow: flow.id, ready: ready.id, archived: archived.id, legacy: legacy.id, child: child.id } }, null, 2));
console.log("Isolated UI preflight ready: " + origin);
const close = () => { server.closeAllConnections(); server.close(() => { storage.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); }); };
process.once("SIGTERM", close); process.once("SIGINT", close);
