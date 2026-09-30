import { captureSemanticSignature, type SemanticSignature } from "./chat-render-signature.js";

export interface ChatRenderPlan {
  generation: number;
  sessionId: string;
  messages: SemanticSignature[];
  rows: SemanticSignature[];
  structure: SemanticSignature;
  changedIndices: number[];
  structureChanged: boolean;
}

/** Planning is read-only with respect to the last successfully painted snapshot. */
export class ChatRenderCache {
  private generation = 0;
  private revision = 0;
  private sessionId: string | null = null;
  private messages: SemanticSignature[] = [];
  private rows: SemanticSignature[] = [];
  private structure?: SemanticSignature;

  reset(): void {
    this.generation++;
    this.sessionId = null;
    this.messages = [];
    this.rows = [];
    this.structure = undefined;
  }

  prepare(
    sessionId: string,
    messages: unknown[],
    dependencies: (revisions: number[]) => unknown[],
    structure: unknown,
  ): ChatRenderPlan {
    const sameSession = this.sessionId === sessionId;
    const nextRevision = () => ++this.revision;
    const captured = messages.map((message, index) => captureSemanticSignature(
      message, sameSession ? this.messages[index] : undefined, nextRevision,
    ));
    const rowDependencies = dependencies(captured.map(message => message.revision));
    const rows = captured.map((message, index) => captureSemanticSignature(
      { message: message.revision, dependencies: rowDependencies[index] },
      sameSession ? this.rows[index] : undefined, nextRevision,
    ));
    const capturedStructure = captureSemanticSignature(structure,
      sameSession ? this.structure : undefined, nextRevision);
    return {
      generation: this.generation, sessionId, messages: captured, rows, structure: capturedStructure,
      changedIndices: rows.flatMap((row, index) => !sameSession || row !== this.rows[index] ? [index] : []),
      structureChanged: !sameSession || capturedStructure !== this.structure,
    };
  }

  commit(plan: ChatRenderPlan): void {
    if (plan.generation !== this.generation) return;
    this.sessionId = plan.sessionId;
    this.messages = plan.messages;
    this.rows = plan.rows;
    this.structure = plan.structure;
  }
}
