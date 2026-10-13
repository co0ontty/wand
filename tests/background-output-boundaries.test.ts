import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import test from "node:test";
import { ModelCatalogService } from "../src/models.js";
import { startStructuredCli } from "../src/structured-exec-pump.js";
import { MAX_DIAGNOSTIC_CHARS, MAX_PROTOCOL_LINE_BYTES } from "../src/bounded-process-output.js";

function pump() {
  let kills=0;
  const child=Object.assign(new EventEmitter(), {pid:42,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),
    kill() { kills++; child.emit("close",0,null); return true; }});
  const lines:string[]=[];
  const run=startStructuredCli({sessionId:"fixture",file:"fake",args:[],cwd:process.cwd(),env:{},
    observer:{isActive:()=>true,onUpdate(){}},spawnProcess:(()=>child as unknown as ChildProcess) as typeof spawn,
    createState:()=>({blocks:[],result:"",sessionId:null}),processLine:line=>{lines.push(line);},
    finalize:(ctx,exitCode,signal)=>({state:ctx.state,exitCode,signal,stderr:ctx.stderr,primaryError:null}),
  });
  return {child,run,lines,kills:()=>kills};
}

test("a protocol line is bounded across chunks; truncation can never look like success or rejection", async()=>{
  const h=pump();
  h.child.stdout.emit("data",Buffer.from("x".repeat(MAX_PROTOCOL_LINE_BYTES)));
  h.child.stdout.emit("data",Buffer.from("more\n"));
  const result=await h.run.completion;
  assert.equal(h.lines.length,0);
  assert.equal(h.kills(),1);
  assert.equal(result.exitCode,1);
  assert.equal(result.retryForbidden,true);
  assert.equal(result.failure?.delivery,"unknown");
  assert.equal(result.failure?.retryable,false);
});

test("stderr retains a bounded diagnostic tail without truncating valid protocol lines",async()=>{
  const h=pump();
  h.child.stderr.emit("data",Buffer.from("x".repeat(MAX_DIAGNOSTIC_CHARS*3)+"tail"));
  h.child.stdout.emit("data",Buffer.from("one\ntwo\n"));
  h.child.emit("close",0,null);
  const result=await h.run.completion;
  assert.equal(result.stderr.length,MAX_DIAGNOSTIC_CHARS);
  assert.ok(result.stderr.endsWith("tail"));
  assert.deepEqual(h.lines,["one","two"]);
});

test("closing a model catalog blocks late discovery storage access/publication",async()=>{
  let closed=false,reads=0,writes=0,notifications=0;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const catalog=new ModelCatalogService(()=>{
    assert.equal(closed,false,"late getOptions must not touch closed server services");
    return {storage:{getConfigValue(){assert.equal(closed,false);reads++;return null;},setConfigValue(){assert.equal(closed,false);writes++;}},
      commandRunner:async()=>{await gate;return {stdout:"",stderr:""};},modelsApi:{async *list(){}},
      piEndpointDiscovery:{enabled:false},env:{PATH:""}};
  });
  catalog.onChanged(()=>{notifications++;});
  const pending=catalog.refresh();
  const rejection=assert.rejects(pending,/disposed/);
  catalog.dispose();closed=true;
  const before={reads,writes};
  release();await rejection;
  catalog.publishManagedPiModels();catalog.publishModelGroups();
  await assert.rejects(catalog.refresh(),/disposed/);
  assert.deepEqual({reads,writes},before);
  assert.equal(notifications,0);
});
