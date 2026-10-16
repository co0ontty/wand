import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

function harness() {
  const url = new URL("../src/tui/service-command.ts", import.meta.url);
  const source = readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href));
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const events: string[] = [];
  let finish!: (code: number) => void;
  let fail!: (error: Error) => void;
  const module = { exports: {} as { runTuiServiceCommand: (layout: unknown, command: string, config: string) => Promise<{ ok: boolean }> } };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", code)((name: string) => {
    if (name === "../run-command.js") return { runCommandInteractive: (_file: string, args: string[]) => {
      assert.ok(args.includes("service:restart")); assert.ok(args.includes("/tmp/config.json"));
      events.push("child"); return new Promise<number>((resolve, reject) => { finish = resolve; fail = reject; });
    } };
    if (name === "../error-utils.js") return { getErrorMessage: (error: Error) => error.message };
    return require(name);
  }, module, module.exports);
  const layout = { screen: { program: { pause: () => { events.push("pause"); return () => events.push("resume"); } }, render: () => events.push("render") } };
  return { run: () => module.exports.runTuiServiceCommand(layout, "service:restart", "/tmp/config.json"), events,
    finish: (code: number) => finish(code), fail: () => fail(new Error("cancelled")) };
}

test("TUI gives the terminal to sudo, blocks concurrent operations and restores it", async () => {
  const h = harness();
  const running = h.run();
  assert.deepEqual(h.events, ["pause", "child"]);
  assert.equal((await h.run()).ok, false);
  h.finish(0);
  assert.equal((await running).ok, true);
  assert.deepEqual(h.events, ["pause", "child", "resume", "render"]);
});

test("TUI always restores terminal on rejection and nonzero child exit", async () => {
  for (const rejects of [true, false]) {
    const h = harness(); const running = h.run();
    if (rejects) h.fail(); else h.finish(130);
    assert.equal((await running).ok, false);
    assert.deepEqual(h.events.slice(-2), ["resume", "render"]);
    const next = h.run(); h.finish(0); assert.equal((await next).ok, true);
  }
});
