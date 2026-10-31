// Installed-service acceptance with a temporary local fixture provider; no paid calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const output = join(process.cwd(), "output/pi-steering"); mkdirSync(output, { recursive: true });
const connection = JSON.parse(readFileSync(join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
const origin = new URL(connection.serverURL).origin;
const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
const login = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ appToken: decoded.slice(decoded.lastIndexOf("#") + 1) }), signal: AbortSignal.timeout(20000) });
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
const api = async (route, body, method = body ? "POST" : "GET") => {
  let response;
  try { response = await fetch(new URL(route, origin), { method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }); }
  catch (error) { throw new Error(`installed ${method} ${route} failed: ${error.name}`); }
  assert.ok(response.ok, `installed ${method} ${route} HTTP ${response.status}`);
  return response.json();
};
const calls = [], responses = [];
const provider = createServer(async (request, response) => {
  let raw = ""; for await (const part of request) raw += part;
  if (!raw.trim()) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [] })); return; }
  let body;
  try { body = JSON.parse(raw); } catch { response.writeHead(400); response.end(); return; }
  if (!Array.isArray(body.messages)) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [] })); return; }
  calls.push(body); responses.push(response);
  response.setHeader("content-type", "text/event-stream");
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
const config = JSON.parse(readFileSync(join(process.env.HOME, ".wand/config.json"), "utf8"));
const agent = config.harness?.agentDir?.trim() || join(process.env.HOME, ".pi/agent");
const modelsFile = join(agent, "models.json");
const original = existsSync(modelsFile) ? readFileSync(modelsFile, "utf8") : "{}";
const models = JSON.parse(original);
const providerId = "wandSteeringAcceptance1030";
assert.equal(models.providers?.[providerId], undefined, "fixture provider must not replace an existing entry");
const localProvider = { baseUrl: endpoint, api: "openai-completions", apiKey: "SYNTHETIC_LOCAL_ONLY", models: [{ id: "probe",
  name: "Local steering acceptance", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
const writeModels = value => {
  const temporary = modelsFile + ".steering-" + process.pid + ".tmp";
  writeFileSync(temporary, value, { mode: 0o600, flag: "wx" }); renameSync(temporary, modelsFile);
};
const fixtureModels = JSON.stringify({ ...models, providers: { ...models.providers, [providerId]: localProvider } }, null, 2) + "\n";
// Existing model configuration stays in memory and is never logged or copied to artifacts.
assert.equal(readFileSync(modelsFile, "utf8"), original, "model config changed before fixture setup");
writeModels(fixtureModels);
const wait = async (condition, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("acceptance timeout: " + label);
};
let session;
let completed = false;
try {
  const defaultsBefore = (await api("/api/pi-settings/defaults")).settings;
  session = await api("/api/sessions", { kind: "structured", provider: "pi", engine: "cli", cwd: output,
    model: providerId + "/probe", mode: "managed", thinkingEffort: "off",
    sessionSource: "automation", automationId: "conversation-message:scheduled:local-steering-acceptance",
    systemPrompt: "This is a deterministic local protocol acceptance fixture. Use only its supplied responses." });
  await api(`/api/sessions/${session.id}/pi-settings`, { tools: ["read"], globalTools: false, codemodeOverride: "off",
    goalMode: false, autoResources: false, localDecision: false, resources: { skills: [], mcpServers: [] } }, "PATCH");
  assert.deepEqual((await api("/api/pi-settings/defaults")).settings, defaultsBefore,
    "automation fixture settings must not change user defaults");
  writeFileSync(join(output, "installed-acceptance-session.json"), JSON.stringify({ sessionId: session.id }));
  console.log("acceptance fixture created");
  await api(`/api/sessions/${session.id}/input`, { input: "Local steering acceptance: first", view: "chat", respondImmediately: true });
  await wait(() => calls.length === 1, "initial local request");
  const runId = "structured:" + session.id;
  const slot = createHash("sha256").update(runId).digest("hex").slice(0, 24);
  const job = JSON.parse(readFileSync(join(process.env.HOME, ".wand/pi-native", slot, "current.json"), "utf8"));
  const pid = JSON.parse(readFileSync(job.ready, "utf8")).pid;
  await api(`/api/sessions/${session.id}/input`, { input: "Local steering acceptance: second", view: "chat", respondImmediately: true });
  await api(`/api/sessions/${session.id}/input`, { input: "Local steering acceptance: third", view: "chat", respondImmediately: true });
  const finish = (index, text, tool) => {
    const delta = { role: "assistant", content: text, ...(tool ? { tool_calls: [{ index: 0, id: "acceptance-read", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: join(output, "boundary.txt") }) } }] } : {}) };
    responses[index].end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  writeFileSync(join(output, "boundary.txt"), "local installed boundary result");
  finish(0, "first answer", true);
  await wait(() => calls.length === 2, "first steering");
  assert.ok(JSON.stringify(calls[1]).includes("Local steering acceptance: second"));
  assert.ok(JSON.stringify(calls[1]).includes("local installed boundary result"));
  assert.ok(!JSON.stringify(calls[1]).includes("Local steering acceptance: third"));
  finish(1, "second answer", false);
  await wait(() => calls.length === 3, "second steering");
  assert.ok(JSON.stringify(calls[2]).includes("Local steering acceptance: third"));
  assert.equal(JSON.parse(readFileSync(job.ready, "utf8")).pid, pid);
  finish(2, "third answer", false);
  let snapshot;
  await wait(async () => { snapshot = await api(`/api/sessions/${session.id}?format=chat`); return !snapshot.structuredState?.inFlight; }, "completion");
  assert.deepEqual(snapshot.queuedMessages, []);
  assert.equal(snapshot.messages.filter(turn => turn.role === "user").length, 3);
  const texts = snapshot.messages.map(turn => [turn.role, turn.content.filter(block => block.type === "text").map(block => block.text).join("")]);
  assert.deepEqual(texts, [["user", "Local steering acceptance: first"], ["assistant", "first answer"],
    ["user", "Local steering acceptance: second"], ["assistant", "second answer"],
    ["user", "Local steering acceptance: third"], ["assistant", "third answer"]]);
  const report = { ok: true, installedService: true, localProvider: true, modelRequests: calls.length,
    defaultsUnchanged: true,
    samePiProcess: true, turnBoundaries: 2, queuedMessages: 0, sessionId: session.id, inputMode: snapshot.structuredState?.inputMode };
  writeFileSync(join(output, "installed-acceptance.json"), JSON.stringify(report, null, 2));
  completed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (session && !completed) await api(`/api/sessions/${session.id}/stop`, {}).catch(() => {});
  for (const response of responses) response.destroy();
  await new Promise(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
  const latestRaw = readFileSync(modelsFile, "utf8");
  if (latestRaw === fixtureModels) writeModels(original);
  else {
    const latest = JSON.parse(latestRaw);
    if (JSON.stringify(latest.providers?.[providerId]) === JSON.stringify(localProvider)) {
      delete latest.providers[providerId]; writeModels(JSON.stringify(latest, null, 2) + "\n");
    }
  }
}
