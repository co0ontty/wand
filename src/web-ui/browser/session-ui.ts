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
