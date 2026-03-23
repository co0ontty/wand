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
  ChatMessage,
  CommandRequest,
  ExecutionMode,
  InputRequest,
  PathSuggestion,
  ResizeRequest,
  WandConfig
} from "./types.js";
import { parseMessages } from "./message-parser.js";

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

// Catch-all for unexpected startup errors
process.on("uncaughtException", (err) => {
  wandError("服务器异常", err.message, "请检查配置是否正确，或尝试重启服务。");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  wandError("未处理的异步错误", msg);
});

// ── Friendly error / warn / info helpers ──────────────────────────────────
function wandError(label: string, message: string, suggestion?: string): void {
  process.stderr.write(`\n✗ [wand] ${label}：${message}\n`);
  if (suggestion) process.stderr.write(`  解决方法：${suggestion}\n`);
  process.stderr.write("\n");
}

function wandWarn(message: string, hint?: string): void {
  process.stderr.write(`⚠️  [wand] 警告：${message}\n`);
  if (hint) process.stderr.write(`  提示：${hint}\n`);
}

function wandInfo(message: string): void {
  process.stdout.write(`ℹ️  [wand] ${message}\n`);
}

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
      res.status(429).json({ error: "登录尝试次数过多，请在 15 分钟后再试。" });
      return;
    }

    const { password } = req.body as { password?: string };

    // Check password: prefer database password, fallback to config password
    const dbPassword = storage.getPassword();
    const effectivePassword = dbPassword ?? config.password;

    if (password !== effectivePassword) {
      res.status(401).json({ error: "密码错误，请重试。" });
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
      res.status(400).json({ error: "密码长度至少为 6 个字符。" });
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
      res.status(400).json({ error: getErrorMessage(error, "无法加载路径建议。") });
    }
  });

  app.get("/api/directory", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const targetPath = path.resolve(process.cwd(), q);

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const items = entries
        .sort((a, b) => {
          // Directories first, then alphabetically
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 100)
        .map((entry) => ({
          path: path.join(targetPath, entry.name),
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file"
        }));
      res.json(items);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法读取目录。可能原因：路径不存在或权限不足。") });
    }
  });

  app.get("/api/sessions/:id", (req, res) => {
    const snapshot = processes.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话，可能已被删除。" });
      return;
    }
    if (req.query.format === "chat") {
      // Prefer structured messages from JSON chat mode, fall back to PTY parsing
      const messages = snapshot.messages && snapshot.messages.length > 0
        ? snapshot.messages
        : parseMessages(snapshot.output);
      res.json({ ...snapshot, messages });
    } else {
      res.json(snapshot);
    }
  });

  app.post("/api/commands", (req, res) => {
    const body = req.body as CommandRequest;
    if (!body.command?.trim()) {
      res.status(400).json({ error: "请输入要执行的命令。" });
      return;
    }

    const initialInput = body.initialInput?.trim();

    try {
      const snapshot = processes.start(
        body.command,
        body.cwd,
        normalizeMode(body.mode, config.defaultMode),
        initialInput || undefined
      );
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法启动命令。请检查命令是否正确安装。") });
    }
  });

  app.post("/api/sessions/:id/input", (req, res) => {
    const body = req.body as InputRequest;
    try {
      const snapshot = processes.sendInput(req.params.id, body.input ?? "");
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "会话已结束，请启动新会话。") });
    }
  });

  app.post("/api/sessions/:id/resize", (req, res) => {
    const body = req.body as ResizeRequest;
    try {
      const snapshot = processes.resize(req.params.id, body.cols ?? 0, body.rows ?? 0);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法调整终端大小。") });
    }
  });

  app.post("/api/sessions/:id/stop", (req, res) => {
    try {
      const snapshot = processes.stop(req.params.id);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法停止会话。") });
    }
  });

  app.delete("/api/sessions/:id", (req, res) => {
    try {
      processes.delete(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法删除会话。") });
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
    const sessionToken = readSessionCookie(req);

    if (!sessionToken || !validateSession(sessionToken)) {
      ws.close(1008, "Unauthorized");
      return;
    }

    wsClients.add(ws);

    ws.on("close", () => {
      wsClients.delete(ws);
    });

    ws.on("error", () => {
      // Already closed, ignore
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
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        wandError(
          `端口 ${config.port} 已被占用`,
          `可能有另一个 Wand 进程正在运行。`,
          `解决方法（二选一）：\n1. 在浏览器中访问当前运行的 Wand\n2. 或者终止占用端口的进程：\n   kill $(lsof -ti :${config.port})\n\n如果你确定没有其他实例在运行，可能是有程序意外占用了端口。`
        );
        process.exit(1);
      }
      reject(err);
    });
  });

  // Print security warnings
  if (!storage.hasCustomPassword() && config.password === "change-me") {
    wandWarn(
      "正在使用默认密码（change-me），任何能访问本机的人都可以登录。",
      "修改方法：在界面右上角「设置」中修改密码，或运行：node dist/cli.js config:set password <你的新密码>"
    );
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!validateSession(readSessionCookie(req))) {
    res.status(401).json({ error: "未授权，请先登录。" });
    return;
  }
  next();
}

function normalizeMode(input: string | undefined, fallback: ExecutionMode): ExecutionMode {
  return isExecutionMode(input) ? input : fallback;
}

function readSessionCookie(req: { headers: { cookie?: string } }): string | undefined {
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
