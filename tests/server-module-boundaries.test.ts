import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureDatabaseFile, WandStorage } from "../src/storage.js";
import { SessionRegistry, readHiddenSessionIds } from "../src/session-registry.js";
import { isPathWithinBase } from "../src/middleware/path-safety.js";
import { probeUnixSocket } from "../src/socket-probe.js";
import { callConfiguredAiText, QuickCommitError } from "../src/ai-text-runner.js";
import * as legacy from "../src/git-quick-commit.js";

test("neutral text module preserves legacy API identity without depending on the Git feature",()=>{
  assert.equal(legacy.callConfiguredAiText,callConfiguredAiText);
  assert.equal(legacy.QuickCommitError,QuickCommitError);
  assert.doesNotMatch(readFileSync(new URL("../src/ai-text-runner.ts",import.meta.url),"utf8"),/from ["']\.\/git-quick-commit/);
  assert.doesNotMatch(readFileSync(new URL("../src/server-resume-routes.ts",import.meta.url),"utf8"),/from ["']\.\/server-session-routes/);
});

test("schema entrypoints initialize the same tables without creating a second storage connection owner",t=>{
  const root=mkdtempSync(path.join(tmpdir(),"wand-schema-boundary-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"cold.db");
  ensureDatabaseFile(file);
  const db=new DatabaseSync(file);
  const tables=()=>db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const before=tables();
  assert.ok(before.some(row=>row.name==="scheduled_tasks"));
  assert.ok(before.some(row=>row.name==="conversations"));
  const storage=new WandStorage(file);
  assert.deepEqual(tables(),before);
  storage.close();db.close();
});

test("path containment accepts dot-prefixed children but rejects actual parent traversal",()=>{
  const root=path.resolve("fixture");
  assert.equal(isPathWithinBase(path.join(root,"..notes/report.txt"),root),true);
  assert.equal(isPathWithinBase(path.join(root,"..secret"),root),true);
  assert.equal(isPathWithinBase(path.join(root,"../outside"),root),false);
  assert.equal(isPathWithinBase(path.dirname(root),root),false);
  assert.equal(isPathWithinBase(root,root),true);
});

test("shared socket probe is read-only and distinguishes listening versus gone",async t=>{
  const root=mkdtempSync(path.join(tmpdir(),"wand-socket-probe-")),socket=path.join(root,"s");
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.equal(await probeUnixSocket(socket),false);
  const server=net.createServer(connection=>connection.end());
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,resolve);});
  try{assert.equal(await probeUnixSocket(socket),true);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  assert.equal(await probeUnixSocket(socket),false);
});

test("production registry deletion removes native history and records its tombstone once",t=>{
  const root=mkdtempSync(path.join(tmpdir(),"wand-registry-delete-"));
  const storage=new WandStorage(path.join(root,"wand.db"));
  t.after(()=>{storage.close();rmSync(root,{recursive:true,force:true});});
  const session={id:"fixture",provider:"pi" as const,sessionKind:"pty" as const,command:"pi",cwd:root,mode:"default" as const,
    status:"exited" as const,exitCode:0,startedAt:new Date().toISOString(),endedAt:null,output:"",claudeSessionId:"native-fixture"};
  storage.saveSession(session);
  const actions:string[]=[];let alive=true;
  const processes={getOwned:()=>alive?session:null,delete(id:string){actions.push("managed");alive=false;storage.deleteSession(id);},
    deletePiHistoryFiles(ids:string[]){actions.push("native");assert.deepEqual(ids,["native-fixture"]);}};
  const registry=new SessionRegistry(processes as never,{get:()=>null} as never,storage);
  registry.deleteWithProviderHistory(session.id);
  assert.deepEqual(actions,["managed","native"]);
  assert.ok(readHiddenSessionIds(storage).has("native-fixture"));
  assert.equal(storage.getSession(session.id),null);
});
