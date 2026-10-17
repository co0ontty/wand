import crypto from "node:crypto";
import type { RequestHandler } from "express";
import type { WandStorage } from "./storage.js";

/** A durable receipt survives response loss/restarts. Never replay pending/unknown dispatches. */
export function taskDispatchReceipt(storage: WandStorage): RequestHandler {
  const pending = new Set<string>();
  return (req, res, next) => {
    const taskId = String(req.params.id);
    const requestId = req.body?.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9:_-]{8,80}$/.test(requestId))) {
      res.status(400).json({ error: "派发请求标识无效。" }); return;
    }
    const key = `task-dispatch:${taskId}`;
    type Receipt = { signature?: string; requestId: string; state: "pending" | "accepted" | "unknown"; response?: unknown };
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, canonical(entry)])) : value;
    const { requestId: _requestId, ...scope } = req.body ?? {};
    const signature = crypto.createHash("sha256").update(JSON.stringify(canonical(scope))).digest("hex");
    const previous = storage.getPreference<Receipt | null>(key, null);
    const receiptId = typeof requestId === "string" ? requestId : `legacy:${Date.now()}`;
    const receiptKey = `${key}:request:${receiptId}`;
    const receipt = storage.getPreference<Receipt | null>(receiptKey, null)
      ?? (previous?.requestId === requestId ? previous : null);
    if (requestId && receipt?.state === "accepted") {
      if (receipt.signature && receipt.signature !== signature) {
        res.status(409).json({ error: "该请求已经接受且范围不同，请先核对原会话；不会用旧回执清除新输入。" }); return;
      }
      res.status(202).json(receipt.response); return;
    }
    if (pending.has(taskId) || previous?.state === "pending" || previous?.state === "unknown") {
      res.status(409).json({ error: "前次派发正在处理或送达未知，请核对原任务会话，不能重复派发。" }); return;
    }
    pending.add(taskId);
    const save = (state: Receipt["state"], response?: unknown): void => {
      storage.transaction(() => {
        const record: Receipt = { requestId: receiptId, signature, state, ...(response !== undefined ? { response } : {}) };
        storage.setPreference(key, record);
        storage.setPreference(receiptKey, record);
      });
    };
    save("pending");
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        save("accepted", body);
      } else if (res.statusCode >= 500 || [408, 409].includes(res.statusCode)) {
        save("unknown");
      } else storage.transaction(() => { storage.setPreference(key, null); storage.setPreference(receiptKey, null); });
      pending.delete(taskId);
      return json(body);
    }) as typeof res.json;
    // A dropped connection leaves its receipt pending. The operation may still have started.
    next();
  };
}
