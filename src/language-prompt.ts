/**
 * 强语言指令生成器：供 PTY runner、structured-session-manager（CLI + SDK 两个分支）、
 * 一次性 SDK 调用（claude-sdk-runner.ts）共用。
 *
 * 原本各 runner 散落写 "请使用中文回复" 这种软指令，Claude 写技术内容时还是会条件
 * 反射切英文（"Now let me ..."、"OK, ..."），用户设置中文也照样夹英文。
 *
 * 这一版用三招把约束做硬：
 *   1. 明确禁止常见英文起句模式（"Now let me"、"Let me check"、"OK,"、"First,"
 *      …）并给出反例——给 Claude 一组具体可识别可避免的字串
 *   2. 区分"自然语言"（必须目标语言）和"技术标识符"（路径/命令/API 名可保留原文），
 *      避免 Claude 误以为"代码也要翻译"
 *   3. 自检指令：让 Claude 发现自己即将出错时主动重写
 *
 * 英文模式（"English"）下 Claude 默认就用英文，只补一句 subagent 透传。
 */
export function buildLanguageDirective(language: string): string {
  const trimmed = language?.trim();
  if (!trimmed) return "";

  const isChinese = trimmed === "中文";
  const isEnglish = trimmed === "English" || trimmed.toLowerCase() === "english";

  if (isEnglish) {
    return "When you dispatch a subagent via the Task tool, instruct the subagent in its prompt to also respond in English.";
  }
  if (isChinese) {
    return [
      "【语言要求 — 最高优先级】",
      "你必须始终使用中文进行所有自然语言交流。这是硬性约束，不是建议。",
      "",
      "覆盖范围：",
      "- 所有解释、说明、推理、对话、注释、错误描述、TODO 标题、git commit message、思考内容",
      "- 包括开场白、过渡句、状态汇报、回答用户问题",
      "",
      "严禁以下英文起句模式（即使是技术内容也不要用）：",
      "- 不要写 \"Now let me ...\"、\"Now I'll ...\"、\"Now remove ...\"——改用 \"现在 ...\" 或直接进入正题",
      "- 不要写 \"Let me check ...\"、\"Let me look at ...\"——改用 \"我看一下 ...\"、\"我检查一下 ...\"",
      "- 不要写 \"OK, ...\"、\"Alright, ...\"、\"Great, ...\"——改用 \"好的\"、\"OK\" 中文或直接省略",
      "- 不要写 \"First, ...\"、\"Then, ...\"、\"Finally, ...\"——改用 \"先\"、\"然后\"、\"最后\"",
      "- 不要写 \"Found it!\"、\"Got it!\"——改用 \"找到了\"、\"明白\"",
      "",
      "可以保留原文的部分（这些不算\"自然语言\"）：",
      "- 代码片段、shell 命令、文件路径、URL、API 名、库名、变量名、CSS 属性名等技术标识符",
      "- 引用用户原话、错误信息原文、日志原文",
      "",
      "自检：如果你发现自己即将用英文开始一句话或一段话，立即停下，用中文重新组织语言。",
      "",
      "子代理：当你通过 Task 工具派发 subagent 时，必须在传给 subagent 的 prompt 里明确加上一句中文要求（例如 \"请用中文回复所有自然语言内容\"），保证子代理输出同样遵循。",
    ].join("\n");
  }
  // 其他语言（日语、法语等）——用英文模板，把 language 替进去
  return [
    `[Language requirement — top priority]`,
    `You MUST always use ${trimmed} for all natural-language communication. This is a hard constraint, not a suggestion.`,
    "",
    `Scope: all explanations, narration, reasoning, conversation, comments, error descriptions, TODO titles, git commit messages, and thinking content — including opening phrases, transitions, status updates, and answers to the user.`,
    "",
    `Strictly avoid starting sentences in English (e.g. "Now let me ...", "Let me check ...", "OK, ...", "First, ...", "Found it!"). Use the equivalent ${trimmed} phrasing instead, or skip the transition.`,
    "",
    `What may stay in its original form (these are NOT natural language):`,
    `- Code, shell commands, file paths, URLs, API/library/variable names, CSS properties, other technical identifiers`,
    `- Direct quotes of user input, raw error messages, raw log lines`,
    "",
    `Self-check: if you notice you are about to start a sentence in English, stop and rewrite it in ${trimmed}.`,
    "",
    `Subagent: when you dispatch a subagent via the Task tool, you MUST explicitly instruct the subagent in its prompt to also respond in ${trimmed}.`,
  ].join("\n");
}

/**
 * 完全托管自主模式的系统提示：供 PTY runner 与 structured runner（CLI + SDK）共用，
 * 避免两处各抄一份中英双语文案导致改一处漏一处。
 */
export function buildManagedAutonomyDirective(isChinese: boolean): string {
  return isChinese
    ? "你正在完全托管的自主模式下运行。用户可能无法及时回复问题或确认。你必须独立做出所有决策——自行选择最佳方案，而不是向用户询问偏好、确认或澄清。如果有多种可行方案，选择你认为最合适的并继续执行。除非任务本身存在根本性的歧义且无法合理推断，否则不要等待用户输入。果断行动，自主决策。"
    : "You are running in a fully managed, autonomous mode. The user may not be available to respond to questions or confirmations in a timely manner. You MUST make all decisions independently — choose the best approach yourself instead of asking the user for preferences, confirmations, or clarifications. If multiple approaches are viable, pick the one you judge most appropriate and proceed. Never block on user input unless the task is fundamentally ambiguous and cannot be reasonably inferred. Be decisive and self-directed.";
}
