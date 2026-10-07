import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import test from "node:test";
import { CONNECTED_APP_PRINCIPAL, readSessionCookie } from "../src/auth.js";
import { SettingsWebAccess, SETTINGS_WEB_COOKIE, registerSettingsWebAccessRoute } from "../src/settings-web-access.js";
import type { AuthPrincipal } from "../src/storage.js";

async function fixture(run: (base: string, access: SettingsWebAccess, sessions: Map<string, AuthPrincipal>) => Promise<void>) {
  const sessions = new Map<string, AuthPrincipal>([
    ["fixture-native", { ...CONNECTED_APP_PRINCIPAL, scopes: [...CONNECTED_APP_PRINCIPAL.scopes] }],
    ["fixture-files-only", {kind:"connected-app",scopes:["files"]}],
  ]);
  const access = new SettingsWebAccess();
  const app = express(); app.use(express.json());
  registerSettingsWebAccessRoute(app, {
    access, useHttps: false,
    authenticateSession: (token) => sessions.get(token ?? "") ?? null,
    requireAuth(req,res,next) {
      if (!sessions.has(readSessionCookie(req,false) ?? "")) { res.status(401).json({error:"unauthorized"}); return; }
      next();
    },
  });
  const server=createServer(app); server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address=server.address(); assert.ok(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`,access,sessions); }
  finally {server.close(); await once(server,"close");}
}

test("settings access is issued only for an already authenticated client, never body/query claims", async () => {
  await fixture(async base => {
    for (const cookie of ["", "wand_session_local=invalid-fixture"]) {
      const response=await fetch(`${base}/api/settings/webview-session?client=app`, {
        method:"POST",headers:{Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify({admin:true,client:"app"}),
      });
      assert.equal(response.status,401); assert.equal(response.headers.getSetCookie().length,0);
    }
    const restricted=await fetch(`${base}/api/settings/webview-session`, {
      method:"POST",headers:{Cookie:"wand_session_local=fixture-files-only"},
    });
    assert.equal(restricted.status,403); assert.equal(restricted.headers.getSetCookie().length,0);
  });
});

test("a native settings proof is HttpOnly and bound to the original unchanged native session", async () => {
  await fixture(async (base,access,sessions) => {
    const original=sessions.get("fixture-native");
    const response=await fetch(`${base}/api/settings/webview-session`, {
      method:"POST",headers:{Cookie:"wand_session_local=fixture-native"},
    });
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{ok:true});
    assert.equal(response.headers.get("cache-control"),"no-store");
    const header=response.headers.getSetCookie()[0];
    assert.equal(header.startsWith(`${SETTINGS_WEB_COOKIE}=`),true);
    assert.equal(/HttpOnly/i.test(header),true); assert.equal(/SameSite=Strict/i.test(header),true);
    const proof=header.split(";",1)[0];
    assert.equal(access.accepts("fixture-native",proof),true);
    assert.equal(access.accepts("another-fixture-session",proof),false);
    assert.equal(access.accepts(undefined,proof),false);
    assert.equal(access.accepts("fixture-native",`${SETTINGS_WEB_COOKIE}=forged`),false);
    assert.equal(sessions.get("fixture-native"),original);
    assert.equal(original?.scopes.includes("admin"),false);
    // After logout the original session is gone, so normal requireAuth rejects the proof too.
    sessions.delete("fixture-native");
    const revoked=await fetch(`${base}/api/settings/webview-session`,{
      method:"POST",headers:{Cookie:`wand_session_local=fixture-native; ${proof}`},
    });
    assert.equal(revoked.status,401);
  });
});

test("a new server runtime refuses proof minted by another runtime", () => {
  const first=new SettingsWebAccess(), second=new SettingsWebAccess();
  const proof=`${SETTINGS_WEB_COOKIE}=${first.issue("fixture-native")}`;
  assert.equal(first.accepts("fixture-native",proof),true);
  assert.equal(second.accepts("fixture-native",proof),false);
});
