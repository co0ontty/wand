import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { callCliAiText } = await import(pathToFileURL(join(process.cwd(), "src/ai-text-runner.ts")));
const root = mkdtempSync(join(tmpdir(), "wand-opencode-permissions-"));
const secret = "OFFLINE_PERMISSION_CANARY_71f6";
const source = join(root, "private.txt"), shellTarget = join(root, "shell-ran"), writeTarget = join(root, "write-ran");
writeFileSync(source, secret);
const requests = [];
let fetches = 0;
const server = createServer(async (req, res) => {
  if (req.url === "/forbidden-fetch") { fetches++; res.end("unauthorized"); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const calls = [
    ["read", { filePath: source }],
    ["bash", { command: `touch '${shellTarget}'`, description: "offline test" }],
    ["write", { filePath: writeTarget, content: "must not write" }],
    ["webfetch", { url: `http://127.0.0.1:${server.address().port}/forbidden-fetch`, format: "text" }],
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (requests.length === 1) {
    const names = body.tools.map(t => t.function.name);
    for (const [name] of calls) assert.ok(names.includes(name), `missing native tool ${name}`);
    chunk({ role: "assistant", tool_calls: calls.map(([name, args], index) => ({ index, id: `offline-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
    chunk({}, "tool_calls");
  } else { chunk({ role: "assistant", content: "OK" }); chunk({}, "stop"); }
  res.end("data: [DONE]\n\n");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const old = process.env.OPENCODE_CONFIG_CONTENT;
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  enabled_providers: ["wand-offline-permissions"],
  provider: { "wand-offline-permissions": { npm: "@ai-sdk/openai-compatible", name: "Offline permission test", options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "offline-not-a-credential" }, models: { mock: { name: "Mock", limit: { context: 200000, output: 4096 } } } } },
  permission: { "*": "allow", bash: "allow", read: "allow", write: "allow", webfetch: "allow" },
  agent: { title: { model: "paid/never-call" } },
});
try {
  await assert.rejects(callCliAiText({ system: "Text only.", prompt: "Return OK. Do not use tools." }, root, "", { provider: "opencode", model: "wand-offline-permissions/mock", deadline: Date.now() + 30000 }), /尝试使用工具/);
  assert.equal(existsSync(shellTarget), false);
  assert.equal(existsSync(writeTarget), false);
  assert.equal(fetches, 0);
  assert.equal(JSON.stringify(requests).includes(secret), false);
  // Native CLI may stop immediately on rejected permissions, without another LLM call.
  assert.ok(requests.length >= 1 && requests.length <= 2);
  if (requests[1]) assert.equal(requests[1].messages.filter(m => m.role === "tool").length, 4);
  console.log(JSON.stringify({ passed: true, requests: requests.length, nativeToolSchemas: requests[0].tools.length, attemptedTools: 4, textResultRejected: true, shellExecuted: false, fileWritten: false, fileContentLeaked: false, networkToolExecuted: false, paidTitleCall: false }));
} finally {
  if (old === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = old;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
