import type {
  CreateMissionRequest,
  InboxItem,
  MissionDetails,
  MissionDiff,
  MissionsRepository,
  ReviewComment,
} from "./types";
import { parseJsonResponse } from "../http-adapter";

class HttpMissionsRepository implements MissionsRepository {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  async list(): Promise<MissionDetails[]> {
    const body = await parseJsonResponse<{ missions: MissionDetails[] }>(await this.fetchImpl("/api/missions", { credentials: "same-origin" }));
    return body.missions ?? [];
  }

  async listInbox(): Promise<InboxItem[]> {
    const body = await parseJsonResponse<{ items: InboxItem[] }>(await this.fetchImpl("/api/inbox", { credentials: "same-origin" }));
    return body.items ?? [];
  }

  async markInboxRead(sessionId?: string): Promise<void> {
    await parseJsonResponse(await this.fetchImpl("/api/inbox/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    }));
  }

  async create(request: CreateMissionRequest): Promise<MissionDetails> {
    return parseJsonResponse(await this.fetchImpl("/api/missions", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify(request),
    }));
  }

  async diff(missionId: string, attemptId: string): Promise<MissionDiff> {
    return parseJsonResponse(await this.fetchImpl(`/api/missions/${encodeURIComponent(missionId)}/attempts/${encodeURIComponent(attemptId)}/diff`, { credentials: "same-origin" }));
  }

  async addComment(missionId: string, attemptId: string, input: { filePath: string; line: number | null; side: "old" | "new"; body: string }): Promise<ReviewComment> {
    return parseJsonResponse(await this.fetchImpl(`/api/missions/${encodeURIComponent(missionId)}/attempts/${encodeURIComponent(attemptId)}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(input),
    }));
  }

  async sendReview(missionId: string, attemptId: string): Promise<ReviewComment[]> {
    const body = await parseJsonResponse<{ comments: ReviewComment[] }>(await this.fetchImpl(`/api/missions/${encodeURIComponent(missionId)}/attempts/${encodeURIComponent(attemptId)}/review/send`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}",
    }));
    return body.comments ?? [];
  }
}

export const httpMissionsRepository = new HttpMissionsRepository();
