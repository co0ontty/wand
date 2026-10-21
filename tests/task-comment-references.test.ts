import assert from "node:assert/strict";
import test from "node:test";
import {
  commentReferenceQuery,
  countTaskReference,
  hasTaskReference,
  insertCommentReference,
  parseTaskReferenceIds,
  resolveTaskReferences,
  taskReferenceSegments,
  unknownTaskReferenceIds,
} from "../src/task-comment-references.js";

test("task references: only #TASK-<digits> counts, and only at a word boundary", () => {
  assert.deepEqual(parseTaskReferenceIds("看 #TASK-133 的数据"), ["TASK-133"]);
  assert.deepEqual(parseTaskReferenceIds("#TASK-133 和 #TASK-137 都要"), ["TASK-133", "TASK-137"]);
  assert.deepEqual(parseTaskReferenceIds("重复 #TASK-133 再 #TASK-133"), ["TASK-133"], "the same reference is listed once");
  // Markdown 标题不是引用。
  assert.deepEqual(parseTaskReferenceIds("# 标题"), []);
  assert.deepEqual(parseTaskReferenceIds("#TASK 标题"), []);
  // 普通文字里的 # 不是引用。
  assert.deepEqual(parseTaskReferenceIds("a#TASK-133"), []);
  assert.deepEqual(parseTaskReferenceIds("issue#TASK-133"), []);
  assert.deepEqual(parseTaskReferenceIds("#TASK-133x"), []);
  assert.deepEqual(parseTaskReferenceIds("#TASK-133-"), []);
  assert.deepEqual(parseTaskReferenceIds("C# 和 issue #12 都不是"), []);
  // 引用必须在行首、空白或开括号之后。
  assert.deepEqual(parseTaskReferenceIds("（#TASK-133）"), ["TASK-133"], "CJK brackets are valid boundaries");
  assert.deepEqual(parseTaskReferenceIds("http://x/#TASK-133"), [], "a URL fragment is not a reference");
  assert.deepEqual(parseTaskReferenceIds("看 https://x/doc#TASK-5 继续"), [], "a pasted link must not fail the comment");
  assert.deepEqual(parseTaskReferenceIds("看 https://x/doc#TASK-5 后写 #TASK-133"), ["TASK-133"]);
});

test("task references: presence and count", () => {
  assert.equal(hasTaskReference("做 #TASK-133", "TASK-133"), true);
  assert.equal(hasTaskReference("做 #TASK-134", "TASK-133"), false);
  assert.equal(hasTaskReference("做 #TASK-133", ""), false);
  assert.equal(countTaskReference("#TASK-133 和 #TASK-133", "TASK-133"), 2);
  assert.equal(countTaskReference("#TASK-133 和 #TASK-137", "TASK-133"), 1);
});

test("task references: only the task's own children resolve", () => {
  const children = [{ id: "child-1", identifier: "TASK-133" }, { id: "child-2", identifier: "TASK-137" }];
  assert.deepEqual(resolveTaskReferences("做 #TASK-133 和 #TASK-137", children),
    [{ id: "child-1", identifier: "TASK-133" }, { id: "child-2", identifier: "TASK-137" }]);
  assert.deepEqual(resolveTaskReferences("做 #TASK-999", children), [], "an unknown reference never resolves");
  assert.deepEqual(resolveTaskReferences("没有引用", children), []);
  assert.deepEqual(unknownTaskReferenceIds("做 #TASK-999", children), ["TASK-999"]);
  assert.deepEqual(unknownTaskReferenceIds("做 #TASK-133", children), []);
  assert.deepEqual(unknownTaskReferenceIds("做 #TASK-999 和 #TASK-998", children), ["TASK-999", "TASK-998"]);
});

test("task references: the caret query only fires inside a fresh # token", () => {
  const body = "写 #TASK-1";
  assert.deepEqual(commentReferenceQuery(body, body.length), { start: 2, query: "TASK-1" });
  assert.equal(commentReferenceQuery(body, 3)?.query, "", "the caret right after # starts an empty query");
  assert.equal(commentReferenceQuery("写 #TASK-133 结束", 12), null, "a finished token is not a query");
  assert.equal(commentReferenceQuery("a#TASK", 6), null, "a # glued to a word is not a query");
  assert.equal(commentReferenceQuery("#TASK 133", 8), null, "a space ends the token");
  assert.equal(commentReferenceQuery("没有 #", 3), null);
  assert.equal(commentReferenceQuery("#task-133", 8), null, "the identifier is uppercase");
});

test("task references: insertion replaces the typed token and keeps the caret after it", () => {
  const inserted = insertCommentReference("写 #TASK-13 帮我看看", 10, "TASK-133");
  assert.equal(inserted.body, "写 #TASK-133 帮我看看");
  assert.equal(inserted.caret, "写 #TASK-133".length, "the caret sits right after the token when a space already follows");
  const fresh = insertCommentReference("写 ", 2, "TASK-133");
  assert.equal(fresh.body, "写 #TASK-133 ");
  assert.equal(fresh.caret, "写 #TASK-133 ".length);
});

test("task references: rendering splits plain text and reference tokens", () => {
  const segments = taskReferenceSegments("先看 #TASK-133 再看 #TASK-137 收工");
  assert.deepEqual(segments, [
    { text: "先看 ", identifier: null },
    { text: "#TASK-133", identifier: "TASK-133" },
    { text: " 再看 ", identifier: null },
    { text: "#TASK-137", identifier: "TASK-137" },
    { text: " 收工", identifier: null },
  ]);
  assert.deepEqual(taskReferenceSegments("没有引用"), [{ text: "没有引用", identifier: null }]);
  assert.deepEqual(taskReferenceSegments("#TASK-133"), [
    { text: "#TASK-133", identifier: "TASK-133" },
  ]);
});
