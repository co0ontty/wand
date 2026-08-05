import type {
  ActivityItem,
  CreateMissionRequest,
  MissionDetails,
  MissionDiff,
  MissionsRepository,
  ReviewComment,
} from "./types";

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok || body.error) throw new Error(body.error || `请求失败 (HTTP ${response.status})`);
  return body as T;
}

export class HttpMissionsRepository implements MissionsRepository {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  async list(): Promise<MissionDetails[]> {
    const body = await json<{ missions: MissionDetails[] }>(await this.fetchImpl("/api/missions", { credentials: "same-origin" }));
    return body.missions ?? [];
  }

  async inbox(): Promise<ActivityItem[]> {
    const body = await json<{ items: ActivityItem[] }>(await this.fetchImpl("/api/inbox", { credentials: "same-origin" }));
    return body.items ?? [];
  }

  async create(request: CreateMissionRequest): Promise<MissionDetails> {
    return json(await this.fetchImpl("/api/missions", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify(request),
    }));
  }

  async diff(missionId: string, attemptId: string): Promise<MissionDiff> {
    return json(await this.fetchImpl(`/api/missions/${encodeURIComponent(missionId)}/attempts/${encodeURIComponent(attemptId)}/diff`, { credentials: "same-origin" }));
  }

  async addComment(missionId: string, attemptId: string, input: { filePath: string; line: number | null; side: "old" | "new"; body: string }): Promise<ReviewComment> {
    return json(await this.fetchImpl(`/api/missions/${encodeURIComponent(missionId)}/attempts/${encodeURIComponent(attemptId)}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(input),
    }));
  }

  async sendReview(missionId: string, attemptId: string): Promise<ReviewComment[]> {
    const body = await json<{ comments: ReviewComment[] }>(await this.fetchImpl(`/api/missions/${encodeURIComponent(missionId)}/attempts/${encodeURIComponent(attemptId)}/review/send`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}",
    }));
    return body.comments ?? [];
  }

  async markRead(sessionId?: string): Promise<void> {
    await json(await this.fetchImpl("/api/inbox/read", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    }));
  }
}

export const httpMissionsRepository = new HttpMissionsRepository();
