import assert from "node:assert/strict";
import test from "node:test";
import { startEmployeeKnowledgeRunner } from "../src/employee-knowledge.js";
import { WebLoginTickets } from "../src/web-login-tickets.js";
import { buildChildEnv } from "../src/env-utils.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerObserver } from "../src/structured-runner.js";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { sanitizeFeedbackText } from "../src/feedback.js";
import { feedbackRequestSecrets } from "../src/server-feedback-routes.js";
import { redactSystemAiText } from "../src/system-ai-redaction.js";

test("ticket and execution-proof formats are redacted even outside known password/token fields", () => {
  const proof = `wlp_${"a".repeat(43)}`, ticket = `wlt_${"b".repeat(43)}`;
  for (const sanitize of [sanitizeFeedbackText, redactSystemAiText]) {
    const safe = sanitize(`unlabelled ${proof} ${ticket}`);
    assert.equal(safe.includes(proof), false); assert.equal(safe.includes(ticket), false);
  }
  assert.ok(feedbackRequestSecrets({ headers: { "x-wand-web-login-proof": proof } }).includes(proof));
});

test("dedicated Web login proof is runtime-bound, overwritten for nested runs and revoked on interrupt/completion", async t => {
  const h = conversationHarness(t);
  const tickets = new WebLoginTickets();
  const session = h.structured.createSession({ cwd: h.cwd, mode: "managed", employeeId: "e_test_1", provider: "pi" });
  for (const interrupt of [false, true]) {
    let received: StructuredRunnerContext | undefined;
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const runner: StructuredRunnerAdapter = { start(context) { received = context; return { completion, interrupt() {} }; } };
    const execution = startEmployeeKnowledgeRunner(h.storage, runner, { session,
      env: { WAND_WEB_LOGIN_PROOF: "inherited-must-not-work" }, prompt: "只读测试" }, {} as StructuredRunnerObserver,
    (sessionId, employeeId) => tickets.grant({ sessionId, employeeId }));
    const proof = received!.env.WAND_WEB_LOGIN_PROOF!;
    assert.match(proof, /^wlp_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(tickets.resolveGrant(proof), { sessionId: session.id, employeeId: session.employeeId });
    assert.doesNotMatch(received!.session.runtimeSystemPrompt ?? "", new RegExp(proof));
    if (interrupt) { execution.interrupt(); assert.equal(tickets.resolveGrant(proof), null); }
    finish(); await execution.completion;
    assert.equal(tickets.resolveGrant(proof), null);
  }
  const previous = process.env.WAND_WEB_LOGIN_PROOF;
  process.env.WAND_WEB_LOGIN_PROOF = "inherited-parent-proof";
  try { assert.equal(buildChildEnv(true).WAND_WEB_LOGIN_PROOF, undefined); }
  finally { if (previous === undefined) delete process.env.WAND_WEB_LOGIN_PROOF; else process.env.WAND_WEB_LOGIN_PROOF = previous; }
});
