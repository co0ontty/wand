import type { Express, Response } from "express";

import { getErrorMessage } from "./error-utils.js";
import type { CreateMissionInput, CreateReviewCommentInput } from "./mission-types.js";
import type { Missions } from "./missions.js";

function sendMissionError(res: Response, error: unknown): void {
  const message = getErrorMessage(error, "任务操作失败。");
  const missing = /^(任务不存在|任务 attempt 不存在)|没有关联会话|当前不可用/.test(message);
  res.status(missing ? 404 : 400).json({ error: message });
}

export function registerMissionRoutes(app: Express, missions: Missions): void {
  app.get("/api/inbox", (_req, res) => {
    res.json({ items: [] });
  });

  app.post("/api/inbox/read", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/missions", (_req, res) => {
    res.json({ missions: missions.list() });
  });

  app.post("/api/missions", (req, res) => {
    try {
      res.status(201).json(missions.create(req.body as CreateMissionInput));
    } catch (error) {
      sendMissionError(res, error);
    }
  });

  app.get("/api/missions/:missionId", (req, res) => {
    const mission = missions.get(req.params.missionId);
    if (!mission) {
      res.status(404).json({ error: "任务不存在。" });
      return;
    }
    res.json(mission);
  });

  app.post("/api/missions/:missionId/archive", (req, res) => {
    try {
      res.json(missions.archive(req.params.missionId));
    } catch (error) {
      sendMissionError(res, error);
    }
  });

  app.get("/api/missions/:missionId/attempts/:attemptId/diff", (req, res) => {
    try {
      res.json(missions.diff(req.params.missionId, req.params.attemptId));
    } catch (error) {
      sendMissionError(res, error);
    }
  });

  app.post("/api/missions/:missionId/attempts/:attemptId/comments", (req, res) => {
    try {
      res.status(201).json(missions.addReviewComment(
        req.params.missionId,
        req.params.attemptId,
        req.body as CreateReviewCommentInput,
      ));
    } catch (error) {
      sendMissionError(res, error);
    }
  });

  app.post("/api/missions/:missionId/attempts/:attemptId/review/send", (req, res) => {
    try {
      const commentIds = Array.isArray(req.body?.commentIds)
        ? req.body.commentIds.filter((id: unknown): id is string => typeof id === "string")
        : undefined;
      res.status(202).json({ comments: missions.sendReview(req.params.missionId, req.params.attemptId, commentIds) });
    } catch (error) {
      sendMissionError(res, error);
    }
  });

  app.post("/api/missions/:missionId/attempts/:attemptId/review/resolve", (req, res) => {
    try {
      const commentIds = Array.isArray(req.body?.commentIds)
        ? req.body.commentIds.filter((id: unknown): id is string => typeof id === "string")
        : [];
      res.json({ comments: missions.resolveReview(req.params.missionId, req.params.attemptId, commentIds) });
    } catch (error) {
      sendMissionError(res, error);
    }
  });
}
