# UX Research Report

## 1. Sidebar Scroll Issue — Root Cause Analysis

The CSS flex scrolling chain is **correctly configured** from top to bottom:

| Element | CSS Properties | Status |
|---------|---------------|--------|
| `.sidebar` (line 341-343) | `display: flex; flex-direction: column; min-height: 0` | OK |
| `.sidebar-body` (line 568-572) | `display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden` | OK |
| `.sessions-list` (line 582) | `flex: 1; overflow-y: auto; padding: 10px` | OK |

All three levels have the required `min-height: 0` on each flex child. The chain is complete.

**Likely causes of scroll not working in practice:**
1. The sidebar is hidden off-screen by default (`transform: translateX(-100%)`) — if it's never opened, users won't notice scroll behavior.
2. When `.sidebar.open` is applied, it becomes visible via `transform: translateX(0)`. If the sessions list is empty or very short, there's nothing to scroll.
3. Potential JavaScript issue: sessions are loaded via API (`GET /api/sessions`), and if the data loads asynchronously after the initial render, the scroll container may not re-evaluate.
4. If sessions have `flex-shrink: 0` items inside the list, they could push the container size beyond expectations.

**Recommendation:** Test with 20+ sessions in the DB. If still not scrolling, check if any JavaScript is overwriting `.sessions-list` styles or manipulating `overflow` properties dynamically.

## 2. Edit Dialog — Code Location

**No user-facing "edit chat message" dialog exists in the codebase.** The closest features are:

- **Tool cards for file edits** (`renderToolUseCard`, line 4400-4419): When AI uses `Edit`, `Write`, or `MultiEdit` tools, they render as diff-style cards (via `renderDiffTool`). These show the file path and changes but are **not editable by the user**.

- **Input textarea** (`renderAppShell`, line 388): The chat input is a `<textarea>` element, not a modal dialog.

- **Session creation modal** (`renderSessionModal`, line 723): A modal for creating new sessions with tool/mode selection.

If the user mentioned a "text modification popup," they may be referring to:
1. The code block Copy button (`.code-copy`, line 4789) — this is a button, not a dialog
2. The tool use card toggle (expandable/collapsible, via `__tcToggle`)
3. A modal for editing session configuration

**Conclusion:** There is no message-editing modal. This feature would need to be implemented from scratch.

## 3. Optimization Suggestions (Prioritized)

### High Priority

1. **Input textarea height limit**: `.input-textarea` has `max-height: 140px` (line 2503). Long messages get cut off. Consider increasing to `240px` or removing the cap with a scrollbar inside the textarea.

2. **No empty state for chat messages**: When `state.selectedId` has no messages, the chat container shows nothing. Add a centered empty state with tips/icons to guide the user.

3. **No error boundary for message rendering**: In `renderStructuredMessage` (line 4105), catching errors shows generic "消息渲染失败" text. Consider logging the error to console and showing a "Retry" option.

4. **Modal lacks keyboard trap completeness**: `setupFocusTrap` (line 2139) exists but Escape key to close modals is inconsistent — `session-modal` and `settings-modal` each have their own close handlers, but `folder-picker-modal` does not handle Escape.

### Medium Priority

5. **Markdown rendering is regex-based**: `renderMarkdown` (line 4699) uses a hand-rolled parser instead of a proven library. This works for simple cases but will struggle with complex nested markdown (tables, nested code blocks, etc.). Consider `marked` or `markdown-it`.

6. **No message action buttons**: Messages lack Copy/Edit/Delete buttons. Modern chat UIs (ChatGPT, Claude web) provide these for each message.

7. **Code blocks use global `highlightCode` function**: The syntax highlighting happens on every render. Consider caching highlighted results if messages are re-rendered.

8. **No loading skeleton for sessions**: When loading sessions from API, there's no loading indicator — just an empty sidebar until data arrives.

9. **Tool use cards show raw JSON on error**: Default card rendering (line 4470) uses `JSON.stringify(block.input, null, 2)` which is verbose and not user-friendly. Better to show a clean error message.

### Low Priority

10. **Session items have hover transform**: `.session-item:hover` has `transform: translateY(-2px)` (line 652) which can cause layout jitter in flex containers. Consider using `margin` or `box-shadow` changes instead.

11. **No session search/filter**: With many sessions, the list becomes hard to navigate. Add a search input above `.sessions-list`.

12. **Mobile responsiveness**: Sidebar width is `min(300px, calc(100vw - 20px))` which is reasonable but the touch targets on session items (padding: 12px 14px) could be larger on mobile.

13. **Animation on every message**: `.chat-message.animate-in` triggers on every message append (line 919-922). On fast message streams, this creates visual noise. Consider throttling to only animate the first message or messages that pause before the next one.
