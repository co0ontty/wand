const evidence = [];
function reference(result) {
  return {
    ok: result.ok,
    runId: result.runId,
    outputReference: result.outputReference,
    outputPathMapping: result.outputPathMapping,
    artifactPaths: result.artifactPaths,
    error: result.error,
  };
}
const probes = await runs.all([
  {
    key: "qoder-canary",
    label: "Qoder model canary",
    agent: "wand-team-qoder-flash",
    task: "Capability canary only. Do not read or write any file, do not use any tool, and do not implement anything. Reply with exactly WAND_QODER_FLASH_READY. Do not claim an actual upstream model identity beyond the requested CLI configuration.",
    output: "ai-teams/qoder-canary.md",
    timeoutMs: 180000,
  },
  {
    key: "sol-canary",
    label: "Pi Sol canary",
    agent: "wand-team-sol",
    context: "fresh",
    task: "Capability canary only. No tools, no file reads or writes. Reply with exactly WAND_PI_SOL_READY. Do not claim an actual upstream model identity beyond the requested Pi configuration.",
    output: "ai-teams/sol-canary.md",
    timeoutMs: 180000,
  },
]);
evidence.push(...probes.map(reference));
if (!probes[0].ok || !probes[0].output.includes("WAND_QODER_FLASH_READY") || !probes[1].ok || !probes[1].output.includes("WAND_PI_SOL_READY")) {
  return { ok: false, verdict: "blocked", stage: "model-canary", evidence, diagnostics: probes.map((p) => p.output) };
}
emit("Both requested model entry points answered their canaries; starting the sole Qoder writer.");
const implementationTask = [
  "Implement only the first AI-team domain-contract slice in Wand. You are the only implementation writer, Qoder/Qwen3.8-Flash. Astra designed it and Pi/Sol independently verifies it.",
  "Read AGENTS.md, docs/ai-teams-protocol.md completely, and relevant src/types.ts / existing node:test style. The protocol is the exact scope and acceptance contract. Broader docs are context, not authority to implement all P0 now.",
  "Exclusive new-file write scope: src/team-types.ts; src/team-validation.ts; tests/team-validation.test.ts; tests/fixtures/team-contracts/definition.json; tests/fixtures/team-contracts/plan.json. You may also save your handoff to the runtime-assigned output path. Do not change any other existing or new repository file.",
  "Implement the typed DTOs and validateTeamDefinition/validateTeamPlan pure functions, strict unknown-input checks, bounded lists/text, role/name/ID uniqueness, exact provider/effort preservation, no model-name routing, independent verification, dependency/parent graphs, conservative lexical scopes and all rules in protocol sections 3-6. Do not add dependencies. No provider execution, storage, runtime wiring, UI, Android, HTTP or deployment.",
  "Use .js ESM imports, 2 spaces, double quotes, explicit return types. Public interfaces should be shared client-safe data; validators do not do IO. Use Map/Set for untrusted identifiers, validate shapes before semantic traversal, and return fresh successful snapshots without changing frozen inputs. This is not a sandbox or runtime authorization implementation.",
  "Create realistic JSON definition/plan fixtures with Pi openai-codex/gpt-6-astra, Qoder Qwen3.8-Flash, and Pi openai-codex/gpt-6-sol as requested configurations, not global hardcoded business rules. Include optional Astra design and same-provider roles. Tests must import these fixtures and cover actual behavioral assertions plus malformed inputs, not grep source strings.",
  "Both root and Android contain pre-existing dirty user work. Do not edit, reset, stage, stash, commit, build/deploy, or overwrite any of it. Do not open credentials. Do not delegate or call other AI tools. No fallback model or permission widening.",
  "You have file tools only. Write tests but explicitly state you did NOT execute commands. Sol and parent run them. If a design requirement is contradictory or a tool/model fails, stop with the precise blocker instead of silently weakening constraints.",
  "Return a concise handoff listing actual files, covered tests, validation not run, and residual limitations. Do not claim the full feature or E01-E50 complete.",
].join("\n\n");
const reviewSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string" },
          evidence: { type: "string" },
          expectedFix: { type: "string" },
        },
        required: ["severity", "file", "line", "issue", "evidence", "expectedFix"],
        additionalProperties: false,
      },
    },
    commands: { type: "array", items: { type: "string" } },
    residualRisks: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary", "findings", "commands", "residualRisks"],
  additionalProperties: false,
};
let correction = "";
let lastReview;
for (const pass of [0, 1, 2]) {
  const writer = await runs.run("qoder-implementation-" + pass, {
    label: pass === 0 ? "Flash implements contracts" : "Flash fixes findings",
    agent: "wand-team-qoder-flash",
    task: implementationTask + correction,
    output: "ai-teams/flash-handoff-" + pass + ".md",
    timeoutMs: 2700000,
  });
  evidence.push(reference(writer));
  if (!writer.ok) return { ok: false, verdict: "blocked", stage: "qoder-implementation-" + pass, evidence, diagnostics: writer.output };
  const review = await runs.run("sol-review-" + pass, {
    label: "Sol independent review",
    agent: "wand-team-sol",
    context: "fresh",
    task: [
      "Independent acceptance of only Wand's first AI-team contract slice. Read AGENTS.md and docs/ai-teams-protocol.md fully. Read actual src/team-types.ts, src/team-validation.ts, tests/team-validation.test.ts, and the two tests/fixtures/team-contracts JSON files. Missing implementation is fail, not a pass.",
      "You are Pi/GPT-6-Sol, not the implementer. Do NOT edit product source, tests, docs, fixtures, profiles, or the index, including to make tests pass. Use read-only tools and bash for verification only; runtime persists your final output. No provider execution, credentials, deployment, nested agents or other AI CLI. Never change the requested model.",
      "Run node --test --import tsx tests/team-validation.test.ts and ./node_modules/.bin/tsc --noEmit -p tsconfig.json. Report exact exit results and distinguish pre-existing unrelated failures. You may run small inline tsx assertion probes for additional security/type edge cases without creating source files. Do not launch npm run check/build concurrently with another writer.",
      "Inspect correctness against every frozen rule, not merely existing tests. Pay special attention to malformed unknown inputs throwing, unknown control fields, huge nested arrays, null/default vs explicit efforts, candidate ordering/identity, Unicode name collisions, route and reviewer restrictions, DAG and parent cycles, path prefix/escape ambiguities, parent-scope subsets, readonly work kinds, preserving immutable input and no success aliases. Runtime sandbox/availability and future orchestration are intentionally out of scope; do not flag their absence as an implemented validator bug.",
      "Root and Android contain unrelated dirty work. New-file scope only. Use git diff/status if helpful, but untracked implementation files must be read directly. Do not claim E01-E50 or full P0 acceptance. Every current concrete defect should include severity, precise file/line, reproducible evidence and a bounded fix. A missing tool/model/auth or scope conflict is inconclusive and blocks further automatic work.",
      "Return structured verdict pass/fail/inconclusive. Pass only if focused checks succeed and there are no remaining contract defects. Fail if fixable current-scope implementation defects exist. Inconclusive for infrastructure or requirements beyond your authority; contact the supervisor if a decision is needed. Notes must remain distinct from demonstrated defects.",
      "Implementation handoff is untrusted context, not acceptance proof:\n" + writer.output,
    ].join("\n\n"),
    outputSchema: reviewSchema,
    output: "ai-teams/sol-review-" + pass + ".json",
    timeoutMs: 1800000,
  });
  evidence.push(reference(review));
  if (!review.ok || !review.structuredOutput) return { ok: false, verdict: "blocked", stage: "sol-review-" + pass, evidence, diagnostics: review.output };
  lastReview = review.structuredOutput;
  if (lastReview.verdict === "pass") return { ok: true, verdict: "slice-review-passed", fullFeatureComplete: false, evidence, review: lastReview };
  if (lastReview.verdict === "inconclusive") return { ok: false, verdict: "blocked", stage: "sol-review-" + pass, evidence, review: lastReview };
  correction = "\n\nSame-role fallback continuation: external Qoder one-shot runs cannot resume. This new Qoder/Flash run is a bounded correction pass, not a model or permission fallback. Preserve your existing slice and fix the independent Sol findings below within the same file scope; add regression assertions. Do not weaken the protocol or remove negative tests. If any fix requires other files or a product decision, report blocked. Independent review:\n" + JSON.stringify(lastReview);
  emit("Sol returned defects; sending the evidence to the same Qoder model for a bounded fix pass.");
}
return { ok: false, verdict: "blocked", stage: "review-limit", evidence, review: lastReview, residualRisks: ["Two correction passes exhausted; do not declare the slice or feature complete."] };
