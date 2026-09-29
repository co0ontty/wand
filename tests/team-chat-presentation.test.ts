import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ConversationTurn } from "../src/types.js";
import {
  chatDocOwnerPresent,
  chatTurnFingerprint,
  collapsedPreview,
  mentionSegments,
  projectChatTurns,
  type ChatPresentation,
} from "../src/web-ui/react/ai-teams/team-chat-view.js";

const time = (second: number): string => `2026-09-29T10:00:${String(second).padStart(2, "0")}.000Z`;
const turn = (text: string, second: number, name = "设计师"): ConversationTurn => ({
  role: "assistant", createdAt: time(second),
  author: { id: `member-${name}`, name },
  content: [{ type: "text", text }],
});
const ids = (projection: ChatPresentation): string[] => projection.rows.map((row) => row.presentationId);

test("[M-1] longest full mention, paired wrappers, internal spaces, source-aware 420 cutoff", () => {
  const roster = ["设计", "设计师", "张 三", "甲".repeat(36)];
  for (const mark of ["**", "__", "*", "_", "~~"]) {
    const text = `发言 ${mark}@设计师${mark} 和 @张 三、@${"甲".repeat(36)}。`;
    const segments = mentionSegments(text, roster);
    assert.deepEqual(segments.filter((item) => item.mention).map((item) => item.text),
      ["@设计师", "@张 三", `@${"甲".repeat(36)}`]);
    assert.equal(segments.map((item) => item.text).join(""), text);
    assert.equal(mentionSegments(`发言 ${mark}@设计师 错误`, roster).some((item) => item.mention), false);
  }
  assert.equal(mentionSegments("a@设计师", roster).some((item) => item.mention), false);
  assert.equal(mentionSegments("@不在名册", roster).some((item) => item.mention), false);
  const source = `${"字".repeat(417)} @设计师 之后还有更多文字`;
  const preview = collapsedPreview(source);
  assert.equal(preview, `${"字".repeat(417)} @设…`);
  assert.deepEqual(mentionSegments(preview, roster, source), [{ text: preview }], "不能将半截长名猜作短别名");
  assert.deepEqual(mentionSegments(source, roster).filter((item) => item.mention).map((item) => item.text), ["@设计师"]);
  const wrapped = `${"字".repeat(414)} **@设计师** 尾文`;
  assert.equal(mentionSegments(collapsedPreview(wrapped), roster, wrapped).some((item) => item.mention), false,
    "闭标记不在预览里时不得装饰一半");
});

test("[R5] local and server doc owners share scope checks but separate identities", () => {
  const scope = "run/chat";
  const projection = projectChatTurns(null, scope, [turn("历史", 1)]);
  const local = [{ local: true as const, text: "未确认", sentAt: 345, unconfirmed: true }];
  assert.equal(chatDocOwnerPresent(projection.rows[0]!.presentationId, scope, projection, local), true);
  assert.equal(chatDocOwnerPresent("local#345", scope, projection, local), true);
  assert.equal(chatDocOwnerPresent("local#345", "old/run", projection, local), false);
  assert.equal(chatDocOwnerPresent("local#345", scope, projection, []), false);
  assert.equal(chatDocOwnerPresent("local#999", scope, projection, local), false);
  assert.equal(chatDocOwnerPresent(projection.rows[0]!.presentationId, scope,
    projectChatTurns(projection, scope, []), local), false);
});

test("[I-1] same millisecond/prefix different full text or author, and exact duplicates", () => {
  const prefix = "同毫秒起始相同的文字".repeat(3);
  const a = turn(`${prefix} A`, 1);
  const b = turn(`${prefix} B`, 1);
  const c = turn(`${prefix} A`, 1, "审查者");
  assert.notEqual(chatTurnFingerprint(a), chatTurnFingerprint(b));
  assert.notEqual(chatTurnFingerprint(a), chatTurnFingerprint(c));
  assert.equal(chatTurnFingerprint(a), chatTurnFingerprint({ ...a, usage: { inputTokens: 9 } }));
  const base = projectChatTurns(null, "run1/chat1", [a, b, c, a]);
  assert.equal(new Set(ids(base)).size, 4, "完全相同两条也不能去重/撞 key");
  assert.deepEqual(base.candidates, [], "首载是历史");
  const same = projectChatTurns(base, "run1/chat1", [a, b, c, a].map((row) => ({ ...row })));
  assert.deepEqual(ids(same), ids(base), "整个相同窗口只能观测为未变化");
  const changed = projectChatTurns(same, "run1/chat1", [a, b, c, a, turn("尾", 2)]);
  assert.equal(changed.rows.length, 5);
  assert.equal(changed.rows[1]!.presentationId, base.rows[1]!.presentationId, "不受影响的唯一项保留");
  assert.notEqual(changed.rows[0]!.presentationId, base.rows[0]!.presentationId, "歧义组只要无法对齐就重绑");
  assert.deepEqual(changed.candidates, [], "有重复重叠歧义不能自信地入场");
});

test("[I-2] first empty success, one append, identical reload, 200→200 unique overlap", () => {
  const scope = "run1/chat1";
  const empty = projectChatTurns(null, scope, []);
  const first = projectChatTurns(empty, scope, [turn("A", 1)]);
  assert.deepEqual(first.candidates, [first.rows[0]!.presentationId]);
  assert.deepEqual(projectChatTurns(first, scope, [turn("A", 1)]).candidates, []);
  let window = projectChatTurns(null, scope, Array.from({ length: 200 }, (_, i) =>
    turn(`msg-${i}`, 1 + i % 59)));
  const former = ids(window);
  window = projectChatTurns(window, scope, [
    ...window.rows.slice(1).map((row) => ({ ...row.turn })), turn("new-tail", 59),
  ]);
  assert.equal(window.rows.length, 200);
  assert.deepEqual(ids(window).slice(0, 199), former.slice(1), "窗口裁首而不是重挂载整屏");
  assert.deepEqual(window.candidates, [window.rows.at(-1)!.presentationId], "相同长度也识别唯一新尾");
  assert.deepEqual(projectChatTurns(window, scope, window.rows.map((row) => row.turn)).candidates, []);
});

test("[I-2/I-3] no overlap/reorder is static, scope changes clear owner, duplicates rebind only affected group", () => {
  const a = turn("A", 1);
  const b = turn("B", 2);
  const c = turn("C", 3);
  const base = projectChatTurns(null, "r/c", [a, b, c]);
  const unrelated = projectChatTurns(base, "r/c", [turn("new", 4)]);
  assert.deepEqual(unrelated.candidates, [], "无重叠不当新到");
  assert.notEqual(unrelated.rows[0]!.presentationId, base.rows[0]!.presentationId);
  const reorder = projectChatTurns(base, "r/c", [a, c, b]);
  assert.deepEqual(reorder.candidates, []);
  assert.equal(reorder.rows[1]!.presentationId, base.rows[2]!.presentationId, "不受影响的单例仍保留");
  const other = projectChatTurns(base, "r2/c", [a, b, c]);
  assert.deepEqual(other.candidates, []);
  assert.equal(other.rows[0]!.presentationId, "turn-1", "新作用域重新分配，仅作用域联合才是 owner");
  const dupBase = projectChatTurns(null, "r/c", [a, a, b]);
  const changed = projectChatTurns(dupBase, "r/c", [a, b, c]);
  assert.notEqual(changed.rows[0]!.presentationId, dupBase.rows[0]!.presentationId);
  assert.equal(changed.rows[1]!.presentationId, dupBase.rows[2]!.presentationId);
  assert.deepEqual(changed.candidates, [changed.rows[2]!.presentationId]);
  const noTime = projectChatTurns(base, "r/c", [a, b, c, { ...turn("unknown", 4), createdAt: undefined }]);
  assert.deepEqual(noTime.candidates, [], "没有可验证时间的新尾静态");
});

test("[I-1–I-3] cross-platform presentation-cases.json is executable, not a prose-only sample", () => {
  const suite = JSON.parse(readFileSync(new URL("./fixtures/team-chat-presentation-cases.json", import.meta.url), "utf8")) as {
    fixtures: Record<string, ConversationTurn>;
    cases: Array<{
      id: string;
      scope: string;
      initial: string[] | { generate: number };
      openOwner?: number;
      steps: Array<{
        successful: boolean;
        scope?: string;
        next: string[] | { dropHead: number; append: string };
        expect: { retained: number[]; rebound: number[]; candidates: number[]; closeOwner: boolean };
      }>;
    }>;
  };
  for (const scenario of suite.cases) {
    let turns = Array.isArray(scenario.initial)
      ? scenario.initial.map((name) => suite.fixtures[name]!)
      : Array.from({ length: scenario.initial.generate }, (_, i) => turn(`window-${i}`, 0));
    let current = projectChatTurns(null, scenario.scope, turns);
    let owner = scenario.openOwner === undefined ? null
      : `${current.scope}/${current.rows[scenario.openOwner]!.presentationId}`;
    for (const step of scenario.steps) {
      const before = current;
      if (step.successful) {
        turns = Array.isArray(step.next)
          ? step.next.map((name) => suite.fixtures[name]!)
          : [...turns.slice(step.next.dropHead), suite.fixtures[step.next.append]!];
        current = projectChatTurns(current, step.scope ?? scenario.scope, turns);
      }
      const oldScoped = new Set(before.rows.map((row) => `${before.scope}/${row.presentationId}`));
      for (const index of step.expect.retained) {
        assert.ok(oldScoped.has(`${current.scope}/${current.rows[index]!.presentationId}`),
          `${scenario.id}: unchanged row ${index} retains its scoped handle`);
      }
      for (const index of step.expect.rebound) {
        assert.ok(!oldScoped.has(`${current.scope}/${current.rows[index]!.presentationId}`),
          `${scenario.id}: ambiguous/new row ${index} is static rebound`);
      }
      assert.deepEqual(step.successful
        ? current.candidates.map((id) => current.rows.findIndex((row) => row.presentationId === id)) : [],
      step.expect.candidates, `${scenario.id}: only certain appended tail is eligible`);
      const stillOwned = owner === null || current.rows.some((row) =>
        `${current.scope}/${row.presentationId}` === owner);
      assert.equal(!stillOwned, step.expect.closeOwner, `${scenario.id}: doc owner invalidation`);
      if (!stillOwned) owner = null;
    }
  }
});
