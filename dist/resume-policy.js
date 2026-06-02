const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RESUME_COMMAND_ID_PATTERN = new RegExp(`(?:^|\\s)--resume\\s+(${UUID_PATTERN})(?:\\s|$)`, "i");
const CODEX_RESUME_COMMAND_ID_PATTERN = new RegExp(`(?:^|\\s)resume\\s+(${UUID_PATTERN})(?:\\s|$)`, "i");
export function getResumeCommandSessionId(command) {
    const match = RESUME_COMMAND_ID_PATTERN.exec(command);
    return match?.[1] ?? null;
}
export function getCodexResumeCommandSessionId(command) {
    const match = CODEX_RESUME_COMMAND_ID_PATTERN.exec(command);
    return match?.[1] ?? null;
}
