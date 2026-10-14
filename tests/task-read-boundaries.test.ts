import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { SessionRegistry } from "../src/session-registry.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { taskTitleService, whenWandTaskTitlesSettled } from "../src/task-title-service.js";

async function harness(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-read-boundaries-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const registry = new SessionRegistry({ getOwnedSlim: () => null, listSlim: () => [] } as never,
    { getSlim: () => null, listSlim: () => [] } as never, storage);
  const app = express(); app.use(express.json());
  registerWorkspaceRoutes(app, storage, registry);
  registerTaskRoutes(app, { storage, sessions: registry });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close(); rmSync(root, {recursive:true,force:true}); });
  const get = async (endpoint: string) => { const res = await fetch(url+endpoint); assert.equal(res.status,200); return res.json(); };
  return {storage, registry, root, get};
}

test("list and detail projections neither hydrate messages nor mutate read state", async t => {
  const {storage, root, get} = await harness(t);
  const workspace = storage.createWorkspace({name:"Fixture",cwd:root});
  const task = storage.createWorkspaceTask({workspaceId:workspace.id,name:"Named"});
  storage.saveSession({id:"saved",command:"sh",cwd:root,mode:"default",status:"exited",exitCode:0,
    startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),output:"x".repeat(100000),
    workspaceId:workspace.id,workspaceTaskId:task.id,messages:[{role:"user",content:[{type:"text",text:"x".repeat(100000)}]}]});
  storage.updateWorkspaceTask(task.id,{status:"done"});
  await whenWandTaskTitlesSettled();
  const revision=storage.projectionRevision();
  t.mock.method(storage,"getSession",()=>{throw new Error("full transcript read on metadata path");});
  for(const endpoint of ["/api/tasks?revision=", "/api/wand-tasks", "/api/workspaces",
    `/api/workspaces/${workspace.id}`, `/api/workspace-tasks/${task.id}`, "/api/wand-milestones"]) await get(endpoint);
  assert.equal(storage.projectionRevision(),revision);
  assert.equal(storage.getWorkspace(workspace.id)?.lastOpenedAt,null);
  assert.equal(storage.getWorkspaceTask(task.id)?.lastOpenedAt,null);
});

test("task revisions include normalized query identity and detect external writes", async t => {
  const {storage, root, get} = await harness(t);
  const first=storage.createWorkspace({name:"A",cwd:root}), second=storage.createWorkspace({name:"B",cwd:root+"/b"});
  const page=await get(`/api/tasks?revision=&workspaceId=${first.id}`);
  assert.equal((await get(`/api/tasks?revision=${page.revision}&workspaceId=${first.id}`)).unchanged,true);
  assert.equal((await get(`/api/tasks?revision=${page.revision}&workspaceId=${second.id}`)).unchanged,false);
  assert.equal((await get(`/api/tasks?revision=${page.revision}&workspaceId=${first.id}&limit=1`)).unchanged,false);
  assert.equal((await get(`/api/tasks?revision=${page.revision}&workspaceId=${first.id}&maxSessions=1`)).unchanged,false);
  const external=new DatabaseSync(storage.databasePath());
  try { external.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run("External",first.id); }
  finally {external.close();}
  const updated=await get(`/api/tasks?revision=${page.revision}&workspaceId=${first.id}`);
  assert.equal(updated.unchanged,false);
  assert.equal(updated.groups[0].workspaceName,"External");
});

test("title jobs cannot write after storage closes, even if the generator ignores abort", async t => {
  const {storage} = await harness(t);
  let release!: (title:string)=>void;
  const service=taskTitleService(storage,{generateTitle:()=>new Promise(resolve=>{release=resolve;})});
  storage.createWandTask({title:"临时",titleSource:"auto",description:"真实命名输入"});
  service.refresh();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(release);
  storage.close();
  release("迟到标题");
  await new Promise(resolve=>setImmediate(resolve));
});

test("title queues are storage-local and coalesce superseded work before invoking the model", async t => {
  const {storage} = await harness(t);
  let release!: (title:string)=>void;
  const sources:string[]=[];
  const service=taskTitleService(storage,{generateTitle:async source=>{
    sources.push(source);
    if(sources.length===1) return new Promise<string>(resolve=>{release=resolve;});
    return "最新标题";
  }});
  storage.createWandTask({title:"占位",description:"first",titleSource:"auto"});
  service.refresh();await new Promise(resolve=>setImmediate(resolve));
  const pending=storage.createWandTask({title:"占位",description:"old",titleSource:"auto"});
  service.refresh();storage.updateWandTask(pending.id,{description:"new"});service.refresh();
  release("第一个标题");await whenWandTaskTitlesSettled();
  assert.deepEqual(sources,["first","new"]);
});
