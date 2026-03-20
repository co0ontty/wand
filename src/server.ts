import express, { NextFunction, Request, Response } from "express";
import { readdir } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import process from "node:process";
import { WebSocketServer, WebSocket } from "ws";
import { createSession, revokeSession, setAuthStorage, validateSession } from "./auth.js";
import { ensureCertificates } from "./cert.js";
import { isExecutionMode, resolveConfigDir } from "./config.js";
import { ProcessManager, ProcessEvent } from "./process-manager.js";
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

// Simple in-memory rate limiter for login attempts
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // 10 attempts per window

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return false;
  }

  record.count++;
  return true;
}

function cleanupRateLimiter(): void {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (now > record.resetAt) {
      loginAttempts.delete(ip);
    }
  }
}

// Cleanup rate limiter every 5 minutes
setInterval(cleanupRateLimiter, 5 * 60 * 1000);

export async function startServer(config: WandConfig, configPath: string): Promise<void> {
  const app = express();
  const storage = new WandStorage(resolveDatabasePath(configPath));
  setAuthStorage(storage);
  const processes = new ProcessManager(config, storage);
  const accessHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const useHttps = config.https !== false; // Default to true
  const protocol = useHttps ? "https" : "http";
  const accessUrl = `${protocol}://${accessHost}:${config.port}`;

  app.use(express.json({ limit: "1mb" }));
  app.use("/vendor/xterm", express.static(path.resolve(process.cwd(), "node_modules/xterm")));
  app.use("/vendor/xterm-addon-fit", express.static(path.resolve(process.cwd(), "node_modules/@xterm/addon-fit")));

  app.get("/", (_req, res) => {
    res.type("html").send(renderApp(configPath));
  });

  // PWA manifest
  app.get("/manifest.json", (_req, res) => {
    res.type("json").send(JSON.stringify({
      name: "Wand Console",
      short_name: "Wand",
      description: "Local CLI Console for Vibe Coding",
      start_url: "/",
      display: "standalone",
      background_color: "#f6f1e8",
      theme_color: "#c5653d",
      orientation: "any",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
      ],
      categories: ["developer tools", "productivity"],
      shortcuts: [
        { name: "New Session", short_name: "New", url: "/?action=new", description: "Start a new CLI session" }
      ]
    }));
  });

  // PWA icons (SVG data URL converted to simple PNG-like response)
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#d77a52"/>
      <stop offset="100%" style="stop-color:#a95130"/>
    </linearGradient></defs>
    <rect width="192" height="192" rx="38" fill="url(#g)"/>
    <text x="96" y="128" text-anchor="middle" font-family="system-ui,sans-serif" font-size="88" font-weight="700" fill="white">W</text>
  </svg>`;

  app.get("/icon-192.png", (_req, res) => {
    res.type("svg").send(iconSvg);
  });

  app.get("/icon-512.png", (_req, res) => {
    res.type("svg").send(iconSvg);
  });

  // Service Worker for offline support
  app.get("/sw.js", (_req, res) => {
    res.type("javascript").send(`
const CACHE_NAME = 'wand-v1';
const STATIC_ASSETS = [
  '/',
  '/vendor/xterm/css/xterm.css',
  '/vendor/xterm/lib/xterm.js',
  '/vendor/xterm-addon-fit/lib/addon-fit.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // API calls should always go to network
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // Static assets: cache first, network fallback
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && event.request.method === 'GET') {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
    }
    return response;
  }).catch(() => caches.match('/'))));
});
`);
  });

  app.post("/api/login", (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";

    if (!checkRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many login attempts. Please try again later." });
      return;
    }

    const { password } = req.body as { password?: string };

    // Check password: prefer database password, fallback to config password
    const dbPassword = storage.getPassword();
    const effectivePassword = dbPassword ?? config.password;

    if (password !== effectivePassword) {
      res.status(401).json({ error: "Invalid password." });
      return;
    }

    const token = createSession();
    res.cookie("wand_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: useHttps,
      maxAge: 1000 * 60 * 60 * 12
    });
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    revokeSession(readSessionCookie(req));
    res.clearCookie("wand_session");
    res.json({ ok: true });
  });

  // Set password endpoint (requires auth)
  app.post("/api/set-password", requireAuth, (req, res) => {
    const { password } = req.body as { password?: string };
    if (!password || password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters." });
      return;
    }
    storage.setPassword(password);
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

  app.delete("/api/sessions/:id", (req, res) => {
    try {
      processes.delete(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to delete session.") });
    }
  });

  await processes.runStartupCommands();

  // Create server (HTTP or HTTPS) - useHttps and protocol already defined above
  const server = useHttps
    ? (() => {
        const ssl = ensureCertificates(resolveConfigDir(configPath));
        return createHttpsServer({ key: ssl.key, cert: ssl.cert }, app);
      })()
    : createHttpServer(app);

  const wss = new WebSocketServer({ server, path: "/ws" });

  // Track WebSocket clients with their subscriptions
  const wsClients = new Set<WebSocket>();

  // Broadcast process events to WebSocket clients
  processes.on("process", (event: ProcessEvent) => {
    const message = JSON.stringify(event);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  });

  wss.on("connection", (ws, req) => {
    // Simple auth check via cookie header
    const cookieHeader = req.headers.cookie || "";
    const sessionMatch = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("wand_session="));
    const sessionToken = sessionMatch?.slice("wand_session=".length);

    if (!sessionToken || !validateSession(sessionToken)) {
      ws.close(1008, "Unauthorized");
      return;
    }

    wsClients.add(ws);

    ws.on("close", () => {
      wsClients.delete(ws);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle subscribe/unsubscribe for specific sessions
        if (msg.type === "subscribe" && msg.sessionId) {
          // Client wants updates for a specific session
          const snapshot = processes.get(msg.sessionId);
          if (snapshot) {
            ws.send(JSON.stringify({ type: "init", sessionId: msg.sessionId, data: snapshot }));
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });
  });

  // Start server
  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => {
      process.stdout.write(
        `[wand] Web console listening on ${protocol}://${accessHost}:${config.port}\n`
      );
      resolve();
    });
    server.on("error", reject);
  });

  // Print security warnings
  if (!storage.hasCustomPassword() && config.password === "change-me") {
    process.stderr.write(
      "\x1b[33m[wand] WARNING: Using default password 'change-me'. Please update your password!\n" +
      "[wand] Use the UI or API to set a new password, or set it in config.\x1b[0m\n"
    );
  }
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
