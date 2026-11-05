/** Only Wand-submitted text, never provider-private instructions or execution credentials. */
export interface ExecutionPromptPart { source: string; text: string }
export interface ExecutionPromptRecord {
  id: string;
  employeeId: string;
  sessionId: string;
  executedAt: string;
  provider: string;
  tool: string;
  model: string;
  channel: string;
  parts: ExecutionPromptPart[];
}
export interface EmployeeExecutionPrompts {
  employeeId: string;
  currentPrompt: string;
  records: ExecutionPromptRecord[];
  nextCursor: number | null;
}
