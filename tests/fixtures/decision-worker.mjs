import { createInterface } from "node:readline";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
emit({ type: "ready", protocol: 1 });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, request } = JSON.parse(line);
  if (request.state === "stall") continue;
  if (request.state === "crash") process.exit(1);
  if (request.state === "bad") { emit({ id, result: {} }); continue; }
  if (request.state === "context") { emit({ id, error: "CONTEXT_LIMIT" }); continue; }
  const answers = Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
    if (q.type === "noul") return [key, { type: "noul", noul: 0.7 }];
    const labels = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    return [key, { type: q.type, confidence: 1, probabilities: Object.fromEntries(labels.map((label, i) => [label, Number(i === 0)])),
      ...(q.type === "choice" ? { choice: labels[0] } : { score: 0 }) }];
  }));
  emit({ id, result: { answers, usage: { input_tokens: 20, output_tokens: 0, truncated: false } } });
}
