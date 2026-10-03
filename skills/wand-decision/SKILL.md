---
name: wand-decision
description: Use Wand's local, offline decision model for bounded classification, candidate selection, rubric scoring, or yes/no judgments over supplied evidence. Useful for quick semantic checks and small repeated judgments, not open-ended reasoning, execution authorization, or authoritative verification.
license: Apache-2.0
compatibility: Wand-managed structured CLI session with command execution permission, Node.js, and an enabled local decision runtime.
---

# Wand local decisions

This is an optional inference tool, not a replacement for your main model. Only call it when a small typed judgment helps the user's task. Do not force it into every turn. Its decision quality is experimental: a local Chinese routing evaluation scored 24/44 and some wrong answers had near-1 probabilities. High probability is not correctness or permission.

## Call the shared HTTP service

Use the bundled `scripts/decide.mjs`, resolved relative to this skill directory:

```sh
node /absolute/path/to/this/skill/scripts/decide.mjs --stdin <<'JSON'
{
  "state": "The customer was billed twice and requests a refund.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which department handles this request?",
      "criteria": {
        "billing": "Payments, invoices and refunds",
        "technical": "Software faults and outages",
        "none": "No matching department or insufficient information"
      }
    }
  }
}
JSON
```

Replace the example skill path with the actual installed path. `--status` checks whether the shared service is enabled and ready without loading the model. The helper calls `wand decide` through the current session's bound executable and uses HTTP; it does not load Python or model weights in the CLI process.

Do not print, copy, persist, or inspect `WAND_DECISION_*` credential values. Never place a token in command arguments, SKILL.md, generated code, or the chat. The runtime binds the service and a short-lived inference-only capability; no caller-selected employee/config overrides are accepted. If unbound, ask to run through an enabled Wand structured session; never read admin passwords or another session's credentials. Installing this skill does not grant shell/MCP/network permissions: when command execution is disallowed, do not bypass that restriction.

## Contract

Input is a JSON object with exactly `state` and `questions`:

- `state`: relevant text, JSON object, or list. Supply evidence, not a demand for a predetermined answer. No automatic access to files, private employee knowledge, history, or external facts.
- `questions`: 1–8 named questions. Each has `type`, `instructions` (nonempty, at most500 characters), and the appropriate `criteria`.
- `choice`: 2–8 unique labels mapped to short descriptions, or a list of labels. Labels at most80 characters, descriptions at most300. Prefer meaningful labels; map them back to stable IDs in your own code. Include an explicit no-match option when appropriate.
- `score`: 2–8 ordered, concrete rubric descriptions. The result is an expected zero-based level, not a newly generated rating scale.
- `noul`: a yes/no proposition, with optional `criteria` keyed only `false`/`true`. Returns P(true); a value near0.5 is uncertainty, not medium intensity.

One request can ask independent questions together; they do not see one another's answers. Maximum body32KiB. The multilingual model's **1024-token limit includes state, instructions and options per question**; character limits do not guarantee token fit. Keep inputs much shorter than a chat transcript. Overlength state, instructions/options that would be truncated, or indistinguishable options are rejected rather than silently used.

Output includes `answers`, per-option probabilities where applicable, `usage`, `runtime`, and `experimental: true`. It does not generate prose, rationales, code, arbitrary strings, or new candidate values. Do not invent an explanation the model did not return. Confidence summarizes a distribution and is not necessarily calibrated for your task or compatible with Jev's formula.

## Use the result safely

- Validate that answers belong to the supplied options and make sense against the actual evidence.
- Do not use this model to approve permissions, destructive commands, credentials, payments, release/publish actions, or automatic task dispatch. Existing user authorization and project rules remain authoritative.
- Hard facts, exact comparisons and eligibility checks belong in ordinary code. Complex planning, ambiguous requests and unsupported topics belong with the main model or the user.
- Do not automatically supply another employee's private knowledge, whole files or unneeded sensitive data. Only provide the minimum evidence you are already authorized to use.
- For `CONTEXT_LIMIT`, `QUESTION_LIMIT` or `OPTIONS_COLLAPSED`, reduce the input while retaining the relevant constraints. Do not drop negations or the actual requested action just to fit.
- For `UNAVAILABLE`, `UNBOUND`, authorization failures, `BUSY`, rate limits or timeouts, state the limitation and continue without this auxiliary judgment or ask the user. No endless retries and no cloud fallback.
- To claim the service was used, require an actual successful tool response. Skill discovery alone is not a successful inference.
