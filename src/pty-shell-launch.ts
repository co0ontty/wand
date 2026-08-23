import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const CLI_EXIT_MARKER_START = "\x1eWAND_CLI_EXIT:";
const CLI_EXIT_MARKER_END = "\x1f";
const POSIX_SHELLS = new Set(["ash", "bash", "dash", "ksh", "ksh93", "mksh", "sh", "zsh"]);

export interface PtyShellLaunchPlan {
  shellArgs: string[];
  /** Fallback for shells whose command language Wand cannot safely wrap. */
  commandToWrite?: string;
  cliExitMarker: PtyCliExitMarker | null;
}

export interface PtyCliExitChunk {
  data: string;
  exitCode: number | null;
}

function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isKnownPosixShell(shell: string): boolean {
  return POSIX_SHELLS.has(path.basename(shell).toLowerCase());
}

/**
 * Commands passed through `shell -c` bypass the interactive line editor, so
 * zsh/bash do not add them to history automatically. Register only the actual
 * provider command (never Wand's marker wrapper) before launching the CLI.
 *
 * Both implementations append instead of rewriting the history file. zsh's
 * incremental append is skipped when the user's history-sharing option already
 * persisted `print -s`, avoiding duplicate entries.
 */
function buildShellHistoryRegistration(command: string, shell: string): string[] {
  const quotedCommand = quotePosixShell(command);
  switch (path.basename(shell).toLowerCase()) {
    case "zsh":
      return [
        `print -s -- ${quotedCommand} 2>/dev/null || :`,
        "if [[ -n ${HISTFILE-} && ${SAVEHIST:-0} -gt 0 ]] "
          + "&& [[ ! -o SHARE_HISTORY && ! -o INC_APPEND_HISTORY && ! -o INC_APPEND_HISTORY_TIME ]]; "
          + "then fc -AI \"$HISTFILE\" 2>/dev/null || :; fi",
      ];
    case "bash":
      return [
        `history -s ${quotedCommand} 2>/dev/null || :`,
        "history -a 2>/dev/null || :",
      ];
    default:
      // Other POSIX shells do not share a portable, non-destructive API for
      // inserting and incrementally persisting a history entry.
      return [];
  }
}

function longestMarkerPrefixSuffix(value: string, markerPrefix: string): number {
  const maxLength = Math.min(value.length, markerPrefix.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(markerPrefix.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Removes Wand's private CLI/shell boundary marker even when a PTY splits it
 * across chunks. The marker never reaches terminal rendering, transcripts, or
 * Claude's PTY parser.
 */
export class PtyCliExitMarker {
  private readonly prefix: string;
  private pending = "";
  private completed = false;

  constructor(readonly token: string = randomUUID()) {
    this.prefix = `${CLI_EXIT_MARKER_START}${token}:`;
  }

  consume(chunk: string): PtyCliExitChunk {
    if (this.completed) return { data: chunk, exitCode: null };

    const combined = this.pending + chunk;
    this.pending = "";
    const markerStart = combined.indexOf(this.prefix);

    if (markerStart >= 0) {
      const markerEnd = combined.indexOf(CLI_EXIT_MARKER_END, markerStart + this.prefix.length);
      if (markerEnd < 0) {
        this.pending = combined.slice(markerStart);
        return { data: combined.slice(0, markerStart), exitCode: null };
      }

      const statusText = combined.slice(markerStart + this.prefix.length, markerEnd);
      if (/^\d{1,3}$/.test(statusText)) {
        this.completed = true;
        return {
          data: combined.slice(0, markerStart) + combined.slice(markerEnd + CLI_EXIT_MARKER_END.length),
          exitCode: Number(statusText),
        };
      }
    }

    const partialLength = longestMarkerPrefixSuffix(combined, this.prefix);
    if (partialLength > 0) {
      this.pending = combined.slice(-partialLength);
      return { data: combined.slice(0, -partialLength), exitCode: null };
    }
    return { data: combined, exitCode: null };
  }
}

function buildTerminalRestoreCommand(): string {
  // Provider TUIs often die on Ctrl+C without leaving the alternate screen or
  // resetting mouse / bracketed-paste / application-keypad modes. Restore a
  // normal interactive tty before handing the session to the user's shell.
  return [
    "printf '\\033[?1049l\\033[?25h\\033[m\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?2004l\\r\\n'",
    "stty sane 2>/dev/null || :",
  ].join("; ");
}

function buildPosixProviderShellCommand(
  command: string,
  shell: string,
  marker: PtyCliExitMarker,
): string {
  // The non-default SIGINT trap keeps the launcher shell alive when Ctrl+C
  // terminates its foreground CLI. External commands reset caught traps to the
  // default disposition, so the provider still receives SIGINT normally.
  // Running the CLI as an `if` condition also prevents a user-set `errexit`
  // option from skipping the marker and fallback shell after a non-zero exit.
  return [
    ...buildShellHistoryRegistration(command, shell),
    "trap ':' INT",
    `if ${command}; then __wand_cli_status=0; else __wand_cli_status=$?; fi`,
    `printf '\\036WAND_CLI_EXIT:${marker.token}:%s\\037' "$__wand_cli_status"`,
    buildTerminalRestoreCommand(),
    // -i forces an interactive prompt even if tty detection is confused after a
    // TUI teardown; -l matches Terminal.app / iTerm login-shell startup files.
    `exec ${quotePosixShell(shell)} -il`,
  ].join("; ");
}

/**
 * Build the PTY process shape without conflating three different lifecycles:
 * a bare interactive shell, a provider CLI that falls back to a shell, and a
 * one-shot non-provider command.
 */
export function buildPtyShellLaunchPlan(options: {
  shell: string;
  command: string;
  bareShell: boolean;
  providerCommand: boolean;
  platform?: NodeJS.Platform;
  markerToken?: string;
}): PtyShellLaunchPlan {
  const platform = options.platform ?? os.platform();
  if (options.bareShell) {
    return {
      shellArgs: platform === "win32" ? [] : ["-il"],
      cliExitMarker: null,
    };
  }

  if (!options.providerCommand) {
    return {
      shellArgs: platform === "win32"
        ? ["/d", "/s", "/c", options.command]
        : ["-lc", options.command],
      cliExitMarker: null,
    };
  }

  if (platform !== "win32" && isKnownPosixShell(options.shell)) {
    const marker = new PtyCliExitMarker(options.markerToken);
    return {
      // Interactive + login initialization matches a real terminal before the
      // provider starts; `exec <shell> -il` becomes the persistent prompt after it exits.
      shellArgs: ["-lic", buildPosixProviderShellCommand(options.command, options.shell, marker)],
      cliExitMarker: marker,
    };
  }

  // cmd.exe/PowerShell and uncommon Unix shells have incompatible scripting
  // syntaxes. Starting them interactively and typing the command still provides
  // the requested Ctrl+C-to-shell behavior; only the precise CLI-exit marker is
  // unavailable on this compatibility path.
  return {
    shellArgs: platform === "win32" ? [] : ["-l"],
    commandToWrite: options.command,
    cliExitMarker: null,
  };
}
