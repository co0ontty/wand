import { state } from "./state";
import { isStructuredSession } from "./session-engine";

      export function getSessionStatusLabel(session) {
        if (!session) return "";
        if (session.permissionBlocked) return "等待授权";
        if (isStructuredSession(session) && session.structuredState && session.structuredState.inFlight) {
          return session.structuredState.phase === "background" ? "后台任务中" : "思考中";
        }
        // provider CLI 进程活着但本轮已结束 → 显示空闲而不是运行中
        if (session.status === "running"
          && session.provider
          && !isStructuredSession(session)
          && session.ptyBusy !== true) return "空闲";
        var statusMap = {
          "idle": "空闲",
          "stopped": "已停止",
          "running": "运行中",
          "thinking": "思考中",
          "waiting-input": "等待输入",
          "waiting_input": "等待输入",
          "reconnecting": "重连中",
          "exited": "已退出",
          "failed": "已失败"
        };
        return statusMap[session.status] || session.status;
      }

      export function getSessionStatusClass(session) {
        if (!session) return "";
        if (session.permissionBlocked) return "permission-blocked";
        if (isStructuredSession(session) && session.structuredState && session.structuredState.inFlight) return "running";
        if (session.status === "running" && session.provider && session.ptyBusy !== true) return "idle";
        return session.status || "";
      }

      /** Get a human-readable activity description for a running session */
      function getSessionActivityDesc(session) {
        if (!session) return "";
        if (session.permissionBlocked) return "等待你的授权";
        if (session.status !== "running") return "";
        // Check WebSocket-delivered currentTask first
        if (session.id === state.selectedId && state.currentTask && state.currentTask.title) {
          return state.currentTask.title;
        }
        // Fall back to snapshot-delivered currentTaskTitle
        if (session.currentTaskTitle) return session.currentTaskTitle;
        return "";
      }

      /** Get the most recent user-sent text from messages (for narrow-strip hover bubble). */
      export function getSessionLatestUserText(session) {
        var msgs = session && session.messages;
        if (!msgs || msgs.length === 0) return "";
        for (var i = msgs.length - 1; i >= 0; i--) {
          var msg = msgs[i];
          if (!msg || msg.role !== "user") continue;
          var content = msg.content;
          if (typeof content === "string") {
            var t = content.trim();
            if (t) return t;
            continue;
          }
          if (Array.isArray(content)) {
            for (var j = 0; j < content.length; j++) {
              var block = content[j];
              if (!block || block.type !== "text" || !block.text) continue;
              if (block.__queued) continue;
              var bt = String(block.text).trim();
              if (bt) return bt;
            }
          }
        }
        return "";
      }

      /** Get the last meaningful assistant text from messages for notification/display */
      export function getLastAssistantSummary(session) {
        var msgs = session && session.messages;
        if (!msgs || msgs.length === 0) return "";
        for (var i = msgs.length - 1; i >= 0; i--) {
          var msg = msgs[i];
          if (msg.role !== "assistant") continue;
          var blocks = msg.content || [];
          for (var j = 0; j < blocks.length; j++) {
            if (blocks[j].type === "text" && blocks[j].text && blocks[j].text.trim()) {
              var text = blocks[j].text.trim();
              // Strip markdown formatting for compact display
              text = text.replace(/^#+\s+/gm, "").replace(/\*\*/g, "").replace(/`/g, "");
              var firstLine = text.split("\n")[0].trim();
              return firstLine.slice(0, 100);
            }
          }
        }
        return "";
      }
