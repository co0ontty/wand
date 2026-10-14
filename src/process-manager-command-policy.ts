/**
 * Tokenize the restricted shell-command subset accepted by the command
 * allowlist. Commands still run through a login shell, so accepting raw string
 * prefixes here would let an allowed executable be followed by another command
 * (`claude; evil`) or be replaced with a similarly-named binary
 * (`claude-malicious`).
 *
 * Quoted and escaped operator characters are retained as ordinary argument
 * data. Unquoted shell control operators and command substitutions are rejected
 * because they can introduce additional executable commands.
 */
function tokenizeAllowedCommand(value: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;

  const pushToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "\n" || char === "\r") {
      return null;
    }

    if (quote === "single") {
      if (char === "'") {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\") {
        const escaped = value[index + 1];
        if (escaped === undefined || escaped === "\n" || escaped === "\r") return null;
        token += escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\"
          ? escaped
          : `\\${escaped}`;
        tokenStarted = true;
        index += 1;
        continue;
      }
      if (char === "`" || (char === "$" && value[index + 1] === "(")) {
        return null;
      }
      token += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushToken();
      continue;
    }
    if (char === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      const escaped = value[index + 1];
      if (escaped === undefined || escaped === "\n" || escaped === "\r") return null;
      token += escaped;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "<" || char === ">" || char === "`") {
      return null;
    }
    if (char === "$" && value[index + 1] === "(") {
      return null;
    }

    token += char;
    tokenStarted = true;
  }

  if (quote !== null) return null;
  pushToken();
  return tokens;
}

/** Exported for focused policy tests. */
export function isCommandAllowedByPrefixes(command: string, allowedPrefixes: readonly string[]): boolean {
  if (allowedPrefixes.length === 0) return true;

  const commandTokens = tokenizeAllowedCommand(command);
  if (!commandTokens || commandTokens.length === 0) return false;

  return allowedPrefixes.some((prefix) => {
    const prefixTokens = tokenizeAllowedCommand(prefix);
    if (!prefixTokens) return false;
    if (prefixTokens.length === 0 || prefixTokens.length > commandTokens.length) return false;
    return prefixTokens.every((token, index) => token === commandTokens[index]);
  });
}
