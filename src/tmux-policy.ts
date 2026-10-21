/** Configuration selects new executions only; existing owners remain recoverable. */
export function tmuxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.WAND_TMUX_MODE;
  if (mode !== undefined && mode !== "required" && mode !== "off") {
    throw new Error("WAND_TMUX_MODE must be required or off");
  }
  if (mode) return mode === "required";
  return env.WAND_TEST_MODE !== "1" && !env.NODE_TEST_CONTEXT;
}
