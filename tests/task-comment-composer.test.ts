import assert from "node:assert/strict";
import test from "node:test";
import { HttpResponseError } from "../src/web-ui/react/http-adapter.js";
import { withCommentRequestStorage } from "./helpers/comment-request-storage.js";
import { acceptCommentDraft, commentDraft, commentMentionHeld, commentMentionQuery, editCommentDraft, insertCommentMention, commentRequestIdentity, commentRequestRejected, settleCommentRequest } from "../src/web-ui/react/issues/task-comment-composer.js";

test("an @ token is a caret query, and only a chosen name remains bound", () => {
  assert.equal(commentMentionQuery("literal @name", "literal @name".length)?.query, "name");
  assert.equal(commentMentionQuery("mail@host", 9), null);
  assert.equal(commentMentionQuery("@瑞辰 已写完", 2)?.query, "瑞");
  assert.equal(commentMentionQuery("@瑞辰 已写完", 4), null);
  assert.equal(commentMentionQuery("@开头", 0), null);
  const inserted = insertCommentMention("请 @虎", 5, "赛博虎妞");
  assert.equal(inserted.body, "请 @赛博虎妞 ");
  assert.equal(inserted.caret, inserted.body.length);
  assert.equal(commentMentionHeld(inserted.body, "赛博虎妞"), true);
  assert.equal(commentMentionHeld("@赛博", "赛博虎妞"), false);
  assert.equal(commentMentionHeld("@瑞辰同学", "瑞辰"), false);
});

test("comment receipt clears only the submitted revision, not edits, other tasks or an ABA draft", () => {
  const first = editCommentDraft("a", { body: "first", employeeId: "stable-a", sourceCommentId: "source-a" });
  editCommentDraft("b", { body: "other", employeeId: "stable-b" });
  editCommentDraft("a", { body: "new input" });
  editCommentDraft("a", { body: "first" });
  assert.equal(acceptCommentDraft("a", first).body, "first");
  assert.equal(commentDraft("b").body, "other");
  const current = commentDraft("a");
  assert.equal(acceptCommentDraft("a", current).body, "");
  assert.equal(commentDraft("a").sourceCommentId, null);
});

test("only definite delivery releases a persisted comment identity; invalid successful receipts stay unknown", async () => {
  await withCommentRequestStorage(async records => {
    const draft = { body: "instruction", employeeId: "stable", sourceCommentId: null, revision: 1 };
    const first = await commentRequestIdentity("task", draft);
    settleCommentRequest(first, { dispatch: { employeeId: "stable", employeeName: "员工", state: "pending", status: "unknown", sessionId: null, error: null } });
    assert.equal((await commentRequestIdentity("task", draft)).requestId, first.requestId);
    assert.equal(records.size, 1);
    assert.ok(![...records.keys()].some(key => key.includes("instruction")), "only a digest is persisted");
    assert.equal(commentRequestRejected(new HttpResponseError("invalid JSON after accepted HTTP", 200)), false);
    assert.equal(commentRequestRejected(new HttpResponseError("conflict", 409)), false);
    assert.equal(commentRequestRejected(new HttpResponseError("explicit rejection", 400)), true);
    settleCommentRequest(first, { dispatch: null });
    assert.equal(records.size, 0);
  });
});
