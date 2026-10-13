// Legacy PTY transcript projection stays synchronous and shared; no rendering or session state.
import { codexActivityRe, codexFooterRe, isPtyCodexNoiseLine, isPtyTranscriptNoiseLine } from "./pty-noise.js";

function stripAnsi(text) {
        return String(text || "")
          .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
          .replace(/\x1b\[(\d+)C/g, function(_match, count) { return " ".repeat(Number(count) || 1); })
          .replace(/\x1b\[[0-9;?]*[AB]/g, "\n")
          .replace(/\x1b\[[0-9;?]*[su]/g, "")
          .replace(/\x1b\[[0-9;?]*[HfJKr]/g, "\n")
          .replace(/\x1bM/g, "\n")
          .replace(/\x1b\[[0-9;?]*[ST]/g, "\n")
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
          .replace(/\x1b[><=ePX^_]/g, "")
          .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n");
      }

export function parseMessages(output, command) {
        var messages = [];
        if (!output) return messages;

        var text = String(output || "");
        var newline = String.fromCharCode(10);
        var carriageReturn = String.fromCharCode(13);
        var esc = String.fromCharCode(27);

        if (/^codex\b/.test(String(command || "").trim())) {
          function stripCodexSegment(raw) {
            return String(raw || "")
              .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
              .replace(/\x1b\[(\d+)C/g, function(_match, count) { return " ".repeat(Number(count) || 1); })
              .replace(/\x1b\[[0-9;?]*[AB]/g, newline)
              .replace(/\x1b\[[0-9;?]*[su]/g, "")
              .replace(/\x1b\[[0-9;?]*[HfJKr]/g, newline)
              .replace(/\x1bM/g, newline)
              .replace(/\x1b\[[0-9;?]*[ST]/g, newline)
              .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
              .replace(/\x1b[><=ePX^_]/g, "")
              .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
              .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
              .replace(/[ \t]+\n/g, newline);
          }

          function normalizeCodexText(value) {
            return String(value || "")
              .replace(/\s+/g, " ")
              .replace(/[M]+$/g, "")
              .trim();
          }

          function normalizeCodexPromptLine(line) {
            return String(line || "")
              .replace(/^›\s*/, "")
              .replace(/^>\s*/, "")
              .trim();
          }

          function extractCodexPromptCandidate(line) {
            var trimmed = String(line || "").trim();
            if (!/^›(?:\s|$)/.test(trimmed)) return null;
            if (codexFooterRe.test(trimmed)) return null;
            var prompt = normalizeCodexText(normalizeCodexPromptLine(trimmed));
            if (!prompt || isPtyCodexNoiseLine(prompt)) return null;
            return prompt;
          }

          function extractCodexAssistantCandidate(line) {
            var trimmed = String(line || "").trim();
            if (!/^[•◦·⏺]/.test(trimmed)) return null;

            var assistant = trimmed
              .replace(/^[•◦·]\s*/, "")
              .replace(/^⏺\s+/, "")
              .replace(/^│\s*/, "")
              .trim();
            if (!assistant || /^[•◦·⏺]$/.test(assistant)) return null;

            assistant = assistant
              .replace(/\s*\(\d+[smh]?\s*•\s*esc to interrupt\)[\s\S]*$/i, "")
              .replace(/(?:[a-z]{1,6})?›[\s\S]*$/, "")
              .replace(/\s{2,}gpt-\d[\s\S]*$/i, "")
              .replace(/\b(?:OpenAI Codex|model:|directory:|Tip:)\b[\s\S]*$/i, "");
            assistant = normalizeCodexText(assistant);

            if (!assistant || assistant.length < 2 || codexActivityRe.test(assistant) || isPtyCodexNoiseLine(assistant)) {
              return null;
            }
            return assistant;
          }

          function extractCodexEchoCandidate(line) {
            var trimmed = normalizeCodexText(line);
            if (!trimmed || isPtyCodexNoiseLine(trimmed)) return null;
            if (/^[•◦·⏺›]/.test(trimmed)) return null;
            if (/^[\[\]<>0-9;?]+u?$/i.test(trimmed)) return null;
            if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return null;
            if (trimmed.length > 500) return null;
            return trimmed;
          }

          function isLikelyAssistantTailArtifact(longer, shorter) {
            if (longer.indexOf(shorter) !== 0) return false;
            var suffix = longer.slice(shorter.length);
            return /^[a-z]{1,4}$/i.test(suffix);
          }

          function coalesceAssistantLines(lines) {
            var collected = [];
            for (var i = 0; i < lines.length; i++) {
              var normalized = normalizeCodexText(lines[i]);
              if (!normalized || normalized.length < 2 || isPtyCodexNoiseLine(normalized)) continue;

              var previous = collected[collected.length - 1];
              if (!previous) {
                collected.push(normalized);
                continue;
              }
              if (normalized === previous) continue;
              if (normalized.indexOf(previous) === 0) {
                collected[collected.length - 1] = normalized;
                continue;
              }
              if (previous.indexOf(normalized) === 0) {
                if (isLikelyAssistantTailArtifact(previous, normalized)) {
                  collected[collected.length - 1] = normalized;
                }
                continue;
              }
              collected.push(normalized);
            }
            return collected.join(newline).trim();
          }

          function extractVisiblePrompt(lines) {
            for (var i = 0; i < lines.length; i++) {
              var line = String(lines[i] || "").trim();
              if (!line) continue;

              var inlinePrompt = extractCodexPromptCandidate(line);
              if (inlinePrompt) return inlinePrompt;

              if (line === "›") {
                for (var j = i + 1; j < lines.length; j++) {
                  var nextLine = normalizeCodexText(lines[j]);
                  if (!nextLine || codexFooterRe.test(nextLine) || isPtyCodexNoiseLine(nextLine)) continue;
                  return nextLine;
                }
              }
            }
            return null;
          }

          function extractVisibleAssistantLines(lines) {
            var assistantLines = [];
            var collecting = false;

            for (var i = 0; i < lines.length; i++) {
              var line = String(lines[i] || "").trim();
              if (!line) {
                if (collecting) break;
                continue;
              }

              var assistant = extractCodexAssistantCandidate(line);
              if (assistant) {
                assistantLines.push(assistant);
                collecting = true;
                continue;
              }

              if (collecting) {
                if (line === "›" || /^›(?:\s|$)/.test(line) || codexFooterRe.test(line) || isPtyCodexNoiseLine(line)) {
                  break;
                }
                assistantLines.push(normalizeCodexText(line));
              }
            }

            return assistantLines;
          }

          var rawCandidates = [];
          var candidateOrder = 0;
          var rawSegments = text.replace(/\r\n?/g, newline).split(newline);
          for (var rs = 0; rs < rawSegments.length; rs++) {
            var cleanedSegment = stripCodexSegment(rawSegments[rs]);
            var pieces = cleanedSegment.split(newline);
            for (var pi = 0; pi < pieces.length; pi++) {
              var piece = String(pieces[pi] || "").trim();
              if (!piece) continue;

              var promptCandidate = extractCodexPromptCandidate(piece);
              if (promptCandidate) {
                rawCandidates.push({ kind: "user", order: candidateOrder++, text: promptCandidate });
                continue;
              }

              var assistantCandidate = extractCodexAssistantCandidate(piece);
              if (assistantCandidate) {
                rawCandidates.push({ kind: "assistant", order: candidateOrder++, text: assistantCandidate });
                continue;
              }

              var echoCandidate = extractCodexEchoCandidate(piece);
              if (echoCandidate) {
                rawCandidates.push({ kind: "echo", order: candidateOrder++, text: echoCandidate });
              }
            }
          }

          var candidates = rawCandidates.filter(function(candidate, index, list) {
            var previous = list[index - 1];
            return !previous || previous.kind !== candidate.kind || previous.text !== candidate.text;
          });

          var explicitUsers = candidates.filter(function(candidate) { return candidate.kind === "user"; });
          var assistantCandidates = candidates.filter(function(candidate) { return candidate.kind === "assistant"; });
          var echoCandidates = candidates.filter(function(candidate) { return candidate.kind === "echo"; });
          var strippedOutput = stripAnsi(text);
          var strippedLines = strippedOutput.split(newline).map(function(line) { return String(line || "").trimEnd(); });
          var visiblePrompt = extractVisiblePrompt(strippedLines);
          var latestExplicitUser = explicitUsers.length ? explicitUsers[explicitUsers.length - 1] : null;
          var echoedUserCandidates = echoCandidates
            .map(function(candidate) { return candidate.text; })
            .filter(function(value) { return value.length >= 3; });
          var latestEchoUser = null;
          for (var eu = echoedUserCandidates.length - 1; eu >= 0; eu--) {
            if (echoedUserCandidates[eu] !== visiblePrompt) {
              latestEchoUser = echoedUserCandidates[eu];
              break;
            }
          }
          if (!latestEchoUser && echoedUserCandidates.length) {
            latestEchoUser = echoedUserCandidates[echoedUserCandidates.length - 1];
          }

          var currentUser = latestExplicitUser ? latestExplicitUser.text : latestEchoUser;
          var rawAssistantLines = assistantCandidates
            .filter(function(candidate) { return !latestExplicitUser || candidate.order > latestExplicitUser.order; })
            .map(function(candidate) { return candidate.text; });
          var visibleAssistantFallback = [];
          var bulletMatches = strippedOutput.match(/^[ \t]*[•◦·⏺][ \t]*(.+)$/gm) || [];
          for (var bm = 0; bm < bulletMatches.length; bm++) {
            var bulletContent = normalizeCodexText(bulletMatches[bm].replace(/^[ \t]*[•◦·⏺][ \t]*/, ""));
            if (!bulletContent) continue;
            if (codexActivityRe.test(bulletContent)) continue;
            if (codexFooterRe.test(bulletContent)) continue;
            if (/\b(?:OpenAI Codex|model:|directory:|Tip:|esc to interrupt)\b/i.test(bulletContent)) continue;
            visibleAssistantFallback.push(bulletContent);
          }

          var assistantText = coalesceAssistantLines(rawAssistantLines)
            || coalesceAssistantLines(extractVisibleAssistantLines(strippedLines))
            || (visibleAssistantFallback.length ? visibleAssistantFallback[visibleAssistantFallback.length - 1] : null);

          if (currentUser) {
            messages.push({ role: "user", content: currentUser });
          }
          if (assistantText) {
            messages.push({ role: "assistant", content: assistantText });
          }
          if (!messages.length && latestExplicitUser) {
            messages.push({ role: "user", content: latestExplicitUser.text });
          } else if (!messages.length && latestEchoUser) {
            messages.push({ role: "user", content: latestEchoUser });
          }

          return messages;
        }

        // Optimized ANSI escape sequence stripping
        // Handles: CSI sequences, OSC sequences, single-character escapes, control chars
        var nul = String.fromCharCode(0);
        var bs = String.fromCharCode(8);
        var vt = String.fromCharCode(11);
        var ff = String.fromCharCode(12);
        var so = String.fromCharCode(14);
        var us = String.fromCharCode(31);
        var nbsp = String.fromCharCode(160);
        var bel = String.fromCharCode(7);
        var ansiRegex = new RegExp(
          esc + '\\[[0-9;?]*[a-zA-Z]|' +  // CSI sequences
          esc + '\\][^' + bel + ']*(' + bel + '|' + esc + '\\\\\\\\)|' +  // OSC sequences - matches ESC ] ... (BEL or ESC \)
          esc + '[><=eP_X^]|' +  // Single-character escapes
          '[' + nul + '-' + bs + vt + ff + so + '-' + us + ']|' +  // Control chars: 0-8, 11, 12, 14-31
          nbsp + '|' + carriageReturn,
          'g'
        );
        var ansiStripped = text.replace(
          ansiRegex,
          function(m) { return m === nbsp ? ' ' : m === carriageReturn ? newline : ''; }
        ).split(carriageReturn).join(newline);

        var lines = ansiStripped.split(newline).map(function(line) { return line.trim(); }).filter(Boolean);

        // Extract thinking/deep thought content
        var thinkingPatterns = [
          /thinking with high effort/i,
          /thinking with medium effort/i,
          /thinking with low effort/i,
          new RegExp("thought for [0-9]+s", "i"),
          new RegExp("Sauteed for [0-9]+m", "i"),
          /Germinating/i,
          /Doodling/i,
          /Brewing/i
        ];

        // Find the most recent thinking line (usually appears after user input)

        // Separate different types of content
        var promptLines = [];  // Try "..." suggestions
        var contentLines = []; // Actual conversation content
        var thinkingLines = [];

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];

          // Check for prompt suggestions (Try "..." pattern, including after ❯)
          var lineForPromptCheck = line.replace(/^❯\s*/, "");
          if (lineForPromptCheck.indexOf('Try"') === 0 || lineForPromptCheck.indexOf('Try "') === 0) {
            promptLines.push(lineForPromptCheck);
            continue;
          }

          // Check for thinking content
          var isThinking = false;
          for (var p = 0; p < thinkingPatterns.length; p++) {
            if (thinkingPatterns[p].test(line)) {
              isThinking = true;
              thinkingLines.push(line);
              break;
            }
          }
          if (isThinking) continue;

          // 界面文案与 CLI 噪声集中在 pty-noise.ts：本函数只管切分，不再维护文案。
          if (isPtyTranscriptNoiseLine(line)) continue;
          // Strip bullet prefix from Claude TUI output lines (keep the content)
          if (line.indexOf("●") === 0) {
            line = line.slice(1).trim();
            if (!line) continue;
            contentLines.push(line);
            continue;
          }
          // Filter partial/fragmented lines (likely from streaming)
          if (line.length < 3 && !/^[a-zA-Z]{3}$/.test(line)) continue;

          contentLines.push(line);
        }

        // Add thinking message (most recent one, deduplicated)
        if (thinkingLines.length > 0) {
          var lastThinking = thinkingLines[thinkingLines.length - 1];
          var durationMatch = lastThinking.match(new RegExp("for ([0-9]+[ms]+| [0-9]+m [0-9]+s)", "i"));
          var thinkingText = durationMatch ? "深度思考 " + durationMatch[0].replace(/for /i, "") : "深度思考中...";
          messages.push({ role: "thinking", content: thinkingText, type: "deep-thought" });
        }

        // Add prompt suggestion as a special message (pulsing display)
        if (promptLines.length > 0) {
          var promptText = promptLines[promptLines.length - 1].replace(/^Try\s*/, "").trim();
          messages.push({ role: "prompt", content: promptText, type: "suggestion" });
        }

        if (!contentLines.length) return messages;

        // ── Multi-turn conversation parsing ──
        // Find ALL ❯ markers to build multiple user/assistant turn pairs
        var turns = [];
        var currentUserText = null;
        var currentAssistantLines = [];

        for (var i = 0; i < contentLines.length; i++) {
          line = contentLines[i];

          if (line.indexOf("❯") === 0) {
            var afterPrompt = line.replace(/^❯\s*/, "").trim();

            // Skip prompt suggestions
            if (afterPrompt.indexOf('Try"') === 0 || afterPrompt.indexOf('Try "') === 0) continue;

            // Finalize previous turn if we had a user message
            if (currentUserText !== null && currentAssistantLines.length > 0) {
              turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
              currentAssistantLines = [];
            }

            if (afterPrompt) {
              currentUserText = afterPrompt;
            } else {
              // Standalone ❯ — just a prompt, no user text
              if (currentUserText !== null && currentAssistantLines.length > 0) {
                turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
                currentAssistantLines = [];
              }
              currentUserText = null;
            }
          } else if (currentUserText !== null) {
            // Filter assistant content lines
            if (line.indexOf("⏺") !== -1 && (line.indexOf("Hi!") !== -1 || line.indexOf("Hello") !== -1 || line.indexOf("What") !== -1 || line.indexOf("working") !== -1)) {
              currentAssistantLines.push(line);
            } else if (line.indexOf("⏺") === 0) {
              currentAssistantLines.push(line.slice(1).trim() || line);
            } else if (line.length >= 8) {
              if (line.indexOf("✢") === -1 && line.indexOf("✳") === -1 && line.indexOf("✶") === -1 && line.indexOf("✻") === -1 && line.indexOf("✽") === -1 &&
                  line.indexOf("▐") !== 0 && line.indexOf("▝") !== 0 && line.indexOf("▘") !== 0 &&
                  line.indexOf("esctointerrupt") === -1 && line.indexOf("?for") !== 0 && line.indexOf("? for") !== 0) {
                currentAssistantLines.push(line);
              }
            }
          }
        }

        // Finalize the last turn
        if (currentUserText !== null && currentAssistantLines.length > 0) {
          turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
        }

        // If no ❯-based turns found, try fallback heuristic (first message without ❯)
        if (turns.length === 0) {
          var fallbackUserText = "";
          var fallbackUserIdx = -1;
          for (var i = 0; i < contentLines.length; i++) {
            line = contentLines[i];
            if (line.indexOf('Try"') === 0 || line.indexOf('Try "') === 0) continue;
            if (line.indexOf('Failed to install') !== -1) continue;
            if (line.indexOf('ctrl+g') !== -1) continue;
            if (line.indexOf('● ') === 0) continue;
            if (line.length < 2 || line.length > 100) continue;
            if (/^[a-zA-Z]/.test(line)) {
              fallbackUserText = line.trim();
              fallbackUserIdx = i;
              break;
            }
          }
          if (fallbackUserText && fallbackUserIdx >= 0) {
            var fallbackAssistant = contentLines.slice(fallbackUserIdx + 1).filter(function(l) {
              return l.length >= 8;
            });
            if (fallbackAssistant.length > 0) {
              turns.push({ user: fallbackUserText, assistantLines: fallbackAssistant });
            }
          }
        }

        // Convert turns to messages
        for (var t = 0; t < turns.length; t++) {
          messages.push({ role: "user", content: turns[t].user });
          if (turns[t].assistantLines.length > 0) {
            var formattedContent = formatAssistantResponse(turns[t].assistantLines.join(newline));
            messages.push({ role: "assistant", content: formattedContent });
          }
        }

        return messages;
      }

function formatAssistantResponse(text) {
        if (!text) return "";

        // Clean up the text
        var newline = String.fromCharCode(10);
        var lines = text.split(newline);
        var cleanLines = [];

        // Remove leading/trailing empty lines and common noise
        var started = false;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var trimmed = line.trim();

          // Skip leading empty lines
          if (!started && !trimmed) continue;
          started = true;

          // Filter out noise patterns
          if (trimmed.indexOf("⏺") === 0 && trimmed.length > 2) {
            cleanLines.push(trimmed.slice(1).trim());
            continue;
          }
          // Strip leading ● bullet from Claude TUI output
          if (trimmed.indexOf("●") === 0) {
            trimmed = trimmed.slice(1).trim();
            if (!trimmed) continue;
            line = trimmed;
          }

          cleanLines.push(line);
        }

        // Remove trailing empty lines
        while (cleanLines.length > 0 && !cleanLines[cleanLines.length - 1].trim()) {
          cleanLines.pop();
        }

        // Deduplicate lines (PTY can echo same content multiple times with/without spaces)
        var deduped = [];
        var seenNorm = {};
        for (var j = 0; j < cleanLines.length; j++) {
          var normalized = cleanLines[j].replace(/\s+/g, "");
          if (normalized.length > 5 && seenNorm[normalized]) continue;
          if (normalized.length > 5) seenNorm[normalized] = true;
          deduped.push(cleanLines[j]);
        }

        // Return plain text — renderChatMessage will handle markdown rendering
        return deduped.join(newline);
      }
