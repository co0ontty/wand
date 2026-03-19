import express, { NextFunction, Request, Response } from "express";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createSession, revokeSession, setAuthStorage, validateSession } from "./auth.js";
import { isExecutionMode } from "./config.js";
import { ProcessManager } from "./process-manager.js";
import { resolveDatabasePath, WandStorage } from "./storage.js";
import { renderApp } from "./web-ui.js";
import {
  CommandRequest,
  ExecutionMode,
  InputRequest,
  PathSuggestion,
  ResizeRequest,
  WandConfig
} from "./types.js";

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function startServer(config: WandConfig, configPath: string): Promise<void> {
  const app = express();
  const storage = new WandStorage(resolveDatabasePath(configPath));
  setAuthStorage(storage);
  const processes = new ProcessManager(config, storage);
  const accessHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const accessUrl = `http://${accessHost}:${config.port}`;

  app.use(express.json({ limit: "1mb" }));
  app.use("/vendor/xterm", express.static(path.resolve(process.cwd(), "node_modules/xterm")));

  app.get("/", (_req, res) => {
    res.type("html").send(renderApp(configPath));
  });

  app.post("/api/login", (req, res) => {
    const { password } = req.body as { password?: string };
    if (password !== config.password) {
      res.status(401).json({ error: "Invalid password." });
      return;
    }

    const token = createSession();
    res.cookie("wand_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      maxAge: 1000 * 60 * 60 * 12
    });
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    revokeSession(readSessionCookie(req));
    res.clearCookie("wand_session");
    res.json({ ok: true });
  });

  app.use("/api", requireAuth);

  app.get("/api/config", (_req, res) => {
    res.json({
      host: config.host,
      port: config.port,
      defaultMode: config.defaultMode,
      defaultCwd: config.defaultCwd,
      commandPresets: config.commandPresets
    });
  });

  app.get("/api/sessions", (_req, res) => {
    res.json(processes.list());
  });

  app.get("/api/path-suggestions", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";

    try {
      const suggestions = await listPathSuggestions(query, config.defaultCwd);
      res.json(suggestions);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to load path suggestions.") });
    }
  });

  app.get("/api/sessions/:id", (req, res) => {
    const snapshot = processes.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    res.json(snapshot);
  });

  app.post("/api/commands", (req, res) => {
    const body = req.body as CommandRequest;
    if (!body.command?.trim()) {
      res.status(400).json({ error: "Command is required." });
      return;
    }

    try {
      const snapshot = processes.start(
        body.command,
        body.cwd,
        normalizeMode(body.mode, config.defaultMode)
      );
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to start command.") });
    }
  });

  app.post("/api/sessions/:id/input", (req, res) => {
    const body = req.body as InputRequest;
    try {
      const snapshot = processes.sendInput(req.params.id, body.input ?? "");
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to send input.") });
    }
  });

  app.post("/api/sessions/:id/resize", (req, res) => {
    const body = req.body as ResizeRequest;
    try {
      const snapshot = processes.resize(req.params.id, body.cols ?? 0, body.rows ?? 0);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to resize session.") });
    }
  });

  app.post("/api/sessions/:id/stop", (req, res) => {
    try {
      const snapshot = processes.stop(req.params.id);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to stop session.") });
    }
  });

  await processes.runStartupCommands();

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      process.stdout.write(
        `[wand] Web console listening on ${accessUrl}\n[wand] HTTP only. Do not open it with https://\n`
      );
      resolve();
    });
    server.on("error", reject);
  });
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!validateSession(readSessionCookie(req))) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
}

function normalizeMode(input: string | undefined, fallback: ExecutionMode): ExecutionMode {
  return isExecutionMode(input) ? input : fallback;
}

function readSessionCookie(req: Request): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) {
    return undefined;
  }

  const match = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("wand_session="));

  return match?.slice("wand_session=".length);
}

async function listPathSuggestions(input: string, fallbackCwd: string): Promise<PathSuggestion[]> {
  const normalizedInput = input.trim();
  const baseInput = normalizedInput || fallbackCwd;
  const resolvedInput = path.resolve(process.cwd(), baseInput);
  const endsWithSeparator = /[\\/]$/.test(normalizedInput);

  let searchDir = resolvedInput;
  let partialName = "";

  if (!endsWithSeparator) {
    searchDir = path.dirname(resolvedInput);
    partialName = path.basename(resolvedInput);
  }

  const entries = await readdir(searchDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !partialName || entry.name.toLowerCase().startsWith(partialName.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((entry) => ({
      path: path.join(searchDir, entry.name),
      name: entry.name,
      isDirectory: true
    }));
}
