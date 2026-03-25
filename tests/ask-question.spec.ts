import { test, expect } from "@playwright/test";
import { login, switchToChatView, openNewSessionModal, closeNewSessionModal, TEST_PASSWORD } from "./setup";

test.describe("Ask Question - What is this project about?", () => {
  test("should ask a question and get response", async ({ page }) => {
    // 1. 登录
    await login(page, TEST_PASSWORD);
    console.log("✅ 登录成功");

    // 2. 打开新会话窗口以创建干净的聊天状态
    await openNewSessionModal(page);
    console.log("📝 打开新会话窗口");

    // 填写命令为 claude
    const commandInput = page.locator("#command");
    await commandInput.fill("claude");
    console.log("✏️ 填写命令：claude");

    // 点击创建按钮
    const createButton = page.locator("#run-button");
    await createButton.click();
    console.log("✅ 创建新会话");

    // 等待会话创建完成并关闭模态框
    await page.waitForSelector("#session-modal", { state: "hidden" });

    // 3. 切换到聊天视图
    await switchToChatView(page);
    console.log("✅ 切换到聊天视图");

    // 4. 检查页面元素是否正常加载
    const chatOutput = page.locator("#chat-output");
    await expect(chatOutput).toBeVisible();
    console.log("✅ 聊天输出区域可见");

    // 5. 检查输入框是否存在
    const inputTextarea = page.locator("#input-box");
    await expect(inputTextarea).toBeVisible();
    console.log("✅ 输入框可见");

    // 6. 记录发送前的消息数量
    const userMessagesBefore = await page.locator(".chat-message.user").count();
    const assistantMessagesBefore = await page.locator(".chat-message.assistant").count();
    console.log(`📊 发送前：用户消息 ${userMessagesBefore} 条，助手消息 ${assistantMessagesBefore} 条`);

    // 7. 输入问题
    await inputTextarea.fill("当前项目是做什么的？");
    console.log("✅ 输入问题：当前项目是做什么的？");

    // 8. 发送消息 (Enter 键)
    await inputTextarea.press("Enter");
    console.log("✅ 发送消息");

    // 9. 等待新的用户消息出现
    const userMessages = page.locator(".chat-message.user");
    await expect(userMessages).toHaveCount(userMessagesBefore + 1, { timeout: 10000 });
    console.log("✅ 用户消息已显示");

    // 10. 等待助手响应
    console.log("⏳ 等待助手响应...");

    // 等待新的 assistant 消息出现
    const assistantMessages = page.locator(".chat-message.assistant");
    await expect(assistantMessages).not.toHaveCount(assistantMessagesBefore, { timeout: 15000 });

    // 等待助手消息内容加载完成（流式输出需要时间）
    await page.waitForTimeout(5000);

    const assistantCount = await assistantMessages.count();
    console.log(`✅ 助手消息已显示，共 ${assistantCount} 条`);

    // 11. 获取用户消息和助手消息的文本 - 获取新增的消息
    const userMessageText = await userMessages.nth(userMessagesBefore).locator(".chat-message-bubble").textContent();
    console.log(`📝 用户消息：${userMessageText}`);

    // 获取所有新增助手消息的合并文本
    let assistantMessageText = "";
    for (let i = assistantMessagesBefore; i < assistantCount; i++) {
      const text = await assistantMessages.nth(i).locator(".chat-message-bubble").textContent();
      assistantMessageText += text + " ";
    }
    console.log(`📝 助手消息 (${assistantCount - assistantMessagesBefore}条): ${assistantMessageText?.substring(0, 500)}`);

    // 12. 截图保存当前状态
    await page.screenshot({ path: "playwright-report/ask-question-result.png" });
    console.log("📸 已保存截图到 playwright-report/ask-question-result.png");

    // 13. 验证
    expect(userMessageText).toContain("当前项目是做什么的？");
    expect(assistantMessageText).toBeTruthy();
    expect(assistantMessageText?.length).toBeGreaterThan(10);

    console.log("\n✅ 测试完成！");
  });
});
