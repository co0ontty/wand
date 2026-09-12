import assert from "node:assert/strict";
import test from "node:test";

import {
  isPlausibleTaskTitle,
  parseGeneratedTaskTitle,
  provisionalTaskTitleFromDescription,
  TASK_TITLE_MAX_LENGTH,
} from "../src/task-title.js";

test("provisional titles use the first meaningful description line", () => {
  assert.equal(provisionalTaskTitleFromDescription("重构会话恢复流程"), "重构会话恢复流程");
  assert.equal(
    provisionalTaskTitleFromDescription("- 修复 Android 终端输入乱码\n- 再看列宽"),
    "修复 Android 终端输入乱码",
  );
  assert.equal(provisionalTaskTitleFromDescription("# 任务\n\n补齐 iOS 更新校验"), "任务");
  // 列表符 + 标点不该变成标题的一部分。
  assert.equal(provisionalTaskTitleFromDescription("1. 给看板加可选标题："), "给看板加可选标题");
  assert.equal(provisionalTaskTitleFromDescription("   \n\n  "), "");
});

test("provisional titles are clipped so they fit the board card", () => {
  const title = provisionalTaskTitleFromDescription("给任务管理面板的自动生成标题加一个可以配置的模型来源，并在失败时回到描述首行");
  assert.ok(title.length <= TASK_TITLE_MAX_LENGTH, `unexpected length ${title.length}`);
  assert.ok(title.startsWith("给任务管理面板"));
});

test("generated titles are stripped of fences, labels, and quotes", () => {
  assert.equal(parseGeneratedTaskTitle("重构会话恢复流程"), "重构会话恢复流程");
  assert.equal(parseGeneratedTaskTitle('```json\n"重构会话恢复流程"\n```'), "重构会话恢复流程");
  assert.equal(parseGeneratedTaskTitle("标题：修复登录失效"), "修复登录失效");
  assert.equal(parseGeneratedTaskTitle("任务标题: 「看板可选标题」"), "看板可选标题");
  assert.equal(parseGeneratedTaskTitle("第一行标题\n第二行解释"), "第一行标题");
  assert.equal(parseGeneratedTaskTitle("   "), "");
});

test("provider error strings are not accepted as titles", () => {
  assert.equal(isPlausibleTaskTitle("重构会话恢复流程"), true);
  assert.equal(isPlausibleTaskTitle("There's an issue with the selected model (gpt-5)."), false);
  assert.equal(isPlausibleTaskTitle("API error: rate limit exceeded"), false);
  assert.equal(isPlausibleTaskTitle("error: model not found"), false);
  assert.equal(isPlausibleTaskTitle("无法连接到服务端，请稍后重试。"), false);
  assert.equal(isPlausibleTaskTitle("失败"), false);
  // 超过面板一行上限的长句/说明不能当标题（先判定再裁剪，裁剪会把长句伪装成标题）。
  assert.equal(isPlausibleTaskTitle("给任务管理面板补上可选的标题字段，并在用户留空时按描述自动生成，同时把标题输入框调小一些"), false);
  assert.equal(isPlausibleTaskTitle("下面是我为你总结的标题。请确认是否可以。"), false);
  assert.equal(isPlausibleTaskTitle(""), false);
});
