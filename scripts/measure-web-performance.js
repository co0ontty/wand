/*
 * Installed-service lab collector for the web performance gate.
 *
 * The browser only navigates and reads. Every non-GET/HEAD /api request from
 * the page is aborted and recorded; authentication and fixture reads use the
 * Playwright request context, not page scripts. No prompt is submitted and no
 * model is invoked. Private message text, titles, cwd and file paths are never
 * copied into the report; the pinned conversation is referenced by hash.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_SCHEMA,
  LAB_GROUPS,
  MEASUREMENT_KIND,
  NETWORK_PROFILES,
  NOT_MEASURED,
  VIEWPORT,
  allScenarios,
  computeCls,
  hashConversationId,
  sanitizeErrorText,
  sanitizeResourcePath,
  scenarioId,
  summarizeRounds,
} from "./web-performance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTION_PATH = path.join(process.env.HOME ?? "", ".wand", "acceptance-connection.json");

function readConnection() {
  if (!existsSync(CONNECTION_PATH)) {
    throw new Error(`Missing ${CONNECTION_PATH}; the lab gate runs against the installed Wand service.`);
  }
  const connection = JSON.parse(readFileSync(CONNECTION_PATH, "utf8"));
  const origin = new URL(connection.serverURL).origin;
  const decoded = Buffer.from(String(connection.connectionCode ?? "").replace(/\s+/g, ""), "base64url").toString();
  const token = decoded.slice(decoded.lastIndexOf("#") + 1);
  if (!token) throw new Error("Acceptance connection has no app token.");
  return { origin, token };
}

async function login(context, origin, token) {
  const response = await context.request.post(origin + "/api/login", { data: { appToken: token } });
  if (response.status() !== 200) throw new Error(`Installed-service login failed with HTTP ${response.status()}.`);
}

async function logout(context, origin) {
  try { await context.request.post(origin + "/api/logout"); } catch { /* best effort; the browser context is closed next */ }
}

async function getJson(context, url) {
  const response = await context.request.get(url);
  if (!response.ok()) throw new Error(`GET ${new URL(url).pathname} failed with HTTP ${response.status()}.`);
  return response.json();
}

function cacheClass(value) {
  if (!value) return "unspecified";
  if (/immutable/i.test(value)) return "immutable";
  if (/no-store/i.test(value)) return "no-store";
  if (/no-cache/i.test(value)) return "no-cache";
  return "other";
}

function responseCategory(pathname, resourceType) {
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  if (pathname.startsWith("/assets/") || pathname.startsWith("/vendor/")) return "asset";
  if (resourceType === "document") return "document";
  if (resourceType === "image") return "image";
  return "other";
}

function aggregateServing(log) {
  const result = { byCategory: {}, statuses: {}, revalidatedAssets: 0 };
  for (const entry of log) {
    const category = entry.category;
    const bucket = result.byCategory[category] ??= { responses: 0, encodings: {}, cacheControls: {} };
    bucket.responses += 1;
    bucket.encodings[entry.encoding] = (bucket.encodings[entry.encoding] ?? 0) + 1;
    const cache = cacheClass(entry.cacheControl);
    bucket.cacheControls[cache] = (bucket.cacheControls[cache] ?? 0) + 1;
    result.statuses[entry.status] = (result.statuses[entry.status] ?? 0) + 1;
    if (entry.status === 304 && (category === "asset" || category === "image")) result.revalidatedAssets += 1;
  }
  return result;
}

function mergeServing(target, source) {
  for (const [category, data] of Object.entries(source?.byCategory ?? {})) {
    const bucket = target.byCategory[category] ??= { responses: 0, encodings: {}, cacheControls: {} };
    bucket.responses += data.responses;
    for (const [key, value] of Object.entries(data.encodings)) bucket.encodings[key] = (bucket.encodings[key] ?? 0) + value;
    for (const [key, value] of Object.entries(data.cacheControls)) bucket.cacheControls[key] = (bucket.cacheControls[key] ?? 0) + value;
  }
  for (const [status, count] of Object.entries(source?.statuses ?? {})) target.statuses[status] = (target.statuses[status] ?? 0) + count;
  target.revalidatedAssets += source?.revalidatedAssets ?? 0;
  return target;
}

function assetChecks(context, origin) {
  const manifestPath = path.join(root, "src/web-ui/content/module-manifest.json");
  if (!existsSync(manifestPath)) return { manifestEntry: null, servedEntry: null, manifestBuildId: null, checks: [] };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return (async () => {
    // The installed service renders its own module-preload graph. Verify the
    // entry it actually serves, not only the local manifest, which may have
    // been rebuilt for the next install while this service keeps running.
    const html = await context.request.get(origin + "/");
    const servedEntry = html.ok()
      ? /\/assets\/(modules\/[a-f0-9]{16}\/runtime\.js)/.exec(await html.text())?.[1] ?? null
      : null;
    const files = [...new Set([servedEntry, manifest.entry, "plush-avatar.js"].filter(Boolean))];
    const checks = [];
    for (const file of files) {
      const response = await context.request.get(origin + "/assets/" + file);
      if (!response.ok()) {
        checks.push({ file, status: response.status(), bytes: null, sha256: null, sourceMatches: null });
        continue;
      }
      const body = await response.body();
      const local = path.join(root, "src/web-ui/content", file);
      checks.push({
        file,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        sourceMatches: existsSync(local) ? body.equals(readFileSync(local)) : null,
      });
    }
    return { manifestEntry: manifest.entry ?? null, servedEntry, manifestBuildId: manifest.buildId ?? null, checks };
  })();
}

async function readDataScale(context, origin) {
  const [sessions, tasks, conversationList] = await Promise.all([
    getJson(context, origin + "/api/sessions"),
    getJson(context, origin + "/api/wand-tasks"),
    getJson(context, origin + "/api/conversations"),
  ]);
  return {
    sessionsTotal: Array.isArray(sessions) ? sessions.length : null,
    wandTasksTotal: Array.isArray(tasks) ? tasks.length : null,
    conversationsTotal: Array.isArray(conversationList.conversations) ? conversationList.conversations.length : null,
  };
}

async function readAdminState(browser, origin, token, { conversationId, conversationHash }) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    await login(context, origin, token);
    const [config, conversationsResponse, dataScale] = await Promise.all([
      getJson(context, origin + "/api/config"),
      getJson(context, origin + "/api/conversations"),
      readDataScale(context, origin),
    ]);
    const conversations = Array.isArray(conversationsResponse.conversations) ? conversationsResponse.conversations : [];
    let selectedId = conversationId ?? null;
    if (selectedId) {
      if (!conversations.some(item => item.id === selectedId)) throw new Error("The requested fixture conversation does not exist.");
    } else if (conversationHash) {
      selectedId = conversations.find(item => hashConversationId(item.id) === conversationHash)?.id ?? null;
      if (!selectedId) throw new Error(`The pinned fixture conversation (${conversationHash}) no longer exists.`);
    } else {
      throw new Error("A pinned conversation is required: pass --conversation when recording the first baseline.");
    }
    const detail = await getJson(context, origin + "/api/conversations/" + encodeURIComponent(selectedId));
    const assets = await assetChecks(context, origin);
    return {
      selectedId,
      config,
      assets,
      dataScale,
      fixture: {
        conversationHash: hashConversationId(selectedId),
        conversationTurns: Array.isArray(detail.messages) ? detail.messages.length : null,
        dataScale,
      },
    };
  } finally {
    await logout(context, origin);
    await context.close();
  }
}

async function readEndScale(browser, origin, token) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    await login(context, origin, token);
    return await readDataScale(context, origin);
  } finally {
    await logout(context, origin);
    await context.close();
  }
}

function urlFor(group, origin, selectedId) {
  if (group.view === "chat") return `${origin}/?view=chats&conversation=${encodeURIComponent(selectedId)}`;
  if (group.view === "taskboard") return `${origin}/?view=taskboard`;
  return `${origin}/?view=workspace`;
}

function installProbe(options) {
  const { selector } = options;
  const state = { longTasks: [], lcp: [], shifts: [], contentMs: null, blockedWrites: [] };
  window.__wandPerf = state;
  try { performance.setResourceTimingBufferSize(5_000); } catch { /* old engines */ }
  // Playwright request routing disables Chromium's HTTP cache, so the read-only
  // write guard lives in the page instead. It rejects fetch/XHR/beacon writes
  // to /api before they reach the network while normal GETs stay untouched.
  const inspectWrite = (url, method) => {
    let parsed;
    try { parsed = new URL(String(url), location.href); } catch { return null; }
    if (parsed.origin !== location.origin) return null;
    if (!(parsed.pathname === "/api" || parsed.pathname.startsWith("/api/"))) return null;
    if (/^(GET|HEAD)$/i.test(String(method || "GET"))) return null;
    return { method: String(method || "GET").toUpperCase(), path: parsed.pathname };
  };
  const record = (entry) => {
    if (entry && state.blockedWrites.length < 50) state.blockedWrites.push(entry);
  };
  try {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const request = input && typeof input === "object" && !(input instanceof URL) ? input : null;
      const url = request ? request.url : String(input);
      const method = (init && init.method) || (request && request.method) || "GET";
      const blocked = inspectWrite(url, method);
      if (blocked) {
        record(blocked);
        return Promise.reject(new TypeError("Read-only performance run blocked an API write"));
      }
      return nativeFetch(input, init);
    };
  } catch { /* keep the native fetch if the page froze it */ }
  try {
    const xhr = window.XMLHttpRequest.prototype;
    const open = xhr.open;
    const send = xhr.send;
    xhr.open = function(method, url, ...rest) {
      this.__wandMethod = method;
      this.__wandUrl = url;
      return open.call(this, method, url, ...rest);
    };
    xhr.send = function(body) {
      const blocked = inspectWrite(this.__wandUrl, this.__wandMethod);
      if (blocked) {
        record(blocked);
        try { this.abort(); } catch { /* already closed */ }
        return undefined;
      }
      return send.call(this, body);
    };
  } catch { /* XMLHttpRequest may be unavailable */ }
  try {
    if (navigator.sendBeacon) {
      const beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function(url, data) {
        const blocked = inspectWrite(url, "POST");
        if (blocked) { record(blocked); return false; }
        return beacon(url, data);
      };
    }
  } catch { /* sendBeacon may be read-only */ }
  const observe = (type, handler) => {
    try {
      new PerformanceObserver(list => { for (const entry of list.getEntries()) handler(entry); }).observe({ type, buffered: true });
    } catch { /* unsupported in this browser */ }
  };
  observe("longtask", entry => state.longTasks.push({ start: entry.startTime, duration: entry.duration }));
  observe("largest-contentful-paint", entry => state.lcp.push({ start: entry.startTime, size: entry.size }));
  observe("layout-shift", entry => state.shifts.push({ start: entry.startTime, value: entry.value, recent: entry.hadRecentInput }));
  const tick = () => {
    if (state.contentMs === null) {
      const node = document.querySelector(selector);
      if (node && node.getClientRects().length > 0) state.contentMs = performance.now();
    }
    if (performance.now() < 30_000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function collectMetrics() {
  const nav = performance.getEntriesByType("navigation")[0];
  const resources = performance.getEntriesByType("resource")
    .filter(entry => entry.name.startsWith(location.origin))
    .map(entry => {
      const url = new URL(entry.name);
      return {
        path: url.pathname,
        initiator: entry.initiatorType,
        start: entry.startTime,
        end: entry.responseEnd,
        transfer: entry.transferSize,
        encoded: entry.encodedBodySize,
        decoded: entry.decodedBodySize,
        protocol: entry.nextHopProtocol,
      };
    });
  const sum = (items, key) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const images = resources.filter(resource => resource.initiator === "img");
  const api = resources.filter(resource => resource.path === "/api" || resource.path.startsWith("/api/"));
  const assets = resources.filter(resource => resource.path.startsWith("/assets/") || resource.path.startsWith("/vendor/"));
  const cacheHits = resources.filter(resource => resource.transfer === 0 && (resource.decoded > 0 || resource.encoded > 0)).length;
  const probe = window.__wandPerf ?? { longTasks: [], lcp: [], shifts: [], contentMs: null };
  const paint = performance.getEntriesByType("paint");
  const imageElements = Array.from(document.querySelectorAll("img"));
  return {
    observedMs: performance.now(),
    navigation: nav ? {
      ttfb: nav.responseStart - nav.requestStart,
      responseEnd: nav.responseEnd,
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      transfer: nav.transferSize,
      encoded: nav.encodedBodySize,
      decoded: nav.decodedBodySize,
    } : null,
    fcpMs: paint.find(entry => entry.name === "first-contentful-paint")?.startTime ?? null,
    lcpMs: probe.lcp.length ? probe.lcp[probe.lcp.length - 1].start : null,
    shifts: probe.shifts.map(entry => ({ start: entry.start, value: entry.value, recent: entry.recent })),
    contentMs: probe.contentMs,
    longTaskOver50Ms: probe.longTasks.reduce((total, entry) => total + Math.max(0, entry.duration - 50), 0),
    longTaskCount: probe.longTasks.length,
    longTaskMaxMs: probe.longTasks.reduce((maximum, entry) => Math.max(maximum, entry.duration), 0),
    domNodes: document.getElementsByTagName("*").length,
    imageCount: images.length,
    imageBytes: sum(images, "transfer"),
    imageDecodedBytes: sum(images, "decoded"),
    imageUnreserved: imageElements.filter(image => !image.getAttribute("width") && !image.getAttribute("height")).length,
    apiRequests: api.length,
    apiBytes: sum(api, "transfer"),
    assetRequests: assets.length,
    assetBytes: sum(assets, "transfer"),
    totalBytes: (nav?.transferSize ?? 0) + sum(resources, "transfer"),
    cacheHits,
    resourceCount: resources.length,
    cacheHitRatio: resources.length ? cacheHits / resources.length : null,
    chatMessages: document.querySelectorAll(".chat-message").length,
    blockedWrites: (probe.blockedWrites ?? []).slice(0, 50),
    resources: resources.map(resource => ({
      path: resource.path,
      initiator: resource.initiator,
      start: Math.round(resource.start),
      end: Math.round(resource.end),
      transfer: resource.transfer,
      encoded: resource.encoded,
      decoded: resource.decoded,
      protocol: resource.protocol,
    })),
  };
}

async function navigateAndCollect(page, state, { url, mode, settleMs, contentSelector, timeout, origin }) {
  state.errors.length = 0;
  state.failedRequests.length = 0;
  state.responses.length = 0;
  const startedAt = Date.now();
  if (mode === "cold") await page.goto(url, { waitUntil: "load", timeout });
  else await page.reload({ waitUntil: "load", timeout });
  let readyTimeout = false;
  try {
    await page.waitForSelector(contentSelector, { state: "visible", timeout });
  } catch {
    readyTimeout = true;
  }
  await page.waitForTimeout(settleMs);
  const raw = await page.evaluate(collectMetrics);
  const resources = raw.resources.map(resource => ({ ...resource, path: sanitizeResourcePath(resource.path) }));
  const metrics = {
    fcpMs: raw.fcpMs,
    lcpMs: raw.lcpMs,
    contentMs: raw.contentMs,
    cls: computeCls(raw.shifts),
    longTaskOver50Ms: raw.longTaskOver50Ms,
    longTaskCount: raw.longTaskCount,
    longTaskMaxMs: raw.longTaskMaxMs,
    domNodes: raw.domNodes,
    imageCount: raw.imageCount,
    imageBytes: raw.imageBytes,
    imageDecodedBytes: raw.imageDecodedBytes,
    imageUnreserved: raw.imageUnreserved,
    apiRequests: raw.apiRequests,
    apiBytes: raw.apiBytes,
    assetRequests: raw.assetRequests,
    assetBytes: raw.assetBytes,
    totalBytes: raw.totalBytes,
    cacheHits: raw.cacheHits,
    cacheHitRatio: raw.cacheHitRatio,
    chatMessages: raw.chatMessages,
  };
  return {
    metrics,
    navigation: raw.navigation,
    observedMs: raw.observedMs,
    wallMs: Date.now() - startedAt,
    readyTimeout,
    errors: state.errors.splice(0),
    failedRequests: state.failedRequests.splice(0),
    blockedWrites: (raw.blockedWrites ?? []).slice(0, 50).map(entry => ({
      method: entry.method,
      path: sanitizeResourcePath(entry.path),
    })),
    serving: aggregateServing(state.responses.splice(0)),
    resources,
  };
}

export async function measureWebPerformance({
  rounds = 3,
  conversationId = null,
  conversationHash = null,
  scenarioIds = null,
  onProgress = () => {},
} = {}) {
  if (!Number.isInteger(rounds) || rounds < 3) throw new Error("At least 3 rounds are required for a stable median.");
  const { origin, token } = readConnection();
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const startedAt = new Date().toISOString();
  const startLoadAverage = loadavg().map(value => Math.round(value * 100) / 100);
  try {
    const browserVersion = browser.version();
    const admin = await readAdminState(browser, origin, token, { conversationId, conversationHash });
    if (conversationHash && admin.fixture.conversationHash !== conversationHash) {
      throw new Error(`Pinned conversation mismatch: expected ${conversationHash}, found ${admin.fixture.conversationHash}.`);
    }
    const selected = scenarioIds ? new Set(scenarioIds) : null;
    const scenarioRounds = new Map(allScenarios().map(scenario => [scenario.id, []]));
    const scenarioServing = new Map(allScenarios().map(scenario => [scenario.id, { byCategory: {}, statuses: {}, revalidatedAssets: 0 }]));
    const groups = LAB_GROUPS.map(group => {
      const required = group.modes.filter(mode => !selected || selected.has(scenarioId(group, mode)));
      if (required.length === 0) return null;
      const modes = [...new Set([...(required.includes("warm") ? ["cold"] : []), ...required])];
      return { group, modes, recorded: new Set(required) };
    }).filter(Boolean);
    if (groups.length === 0) throw new Error("No scenarios matched the filter.");
    for (const { group, modes, recorded } of groups) {
      const network = NETWORK_PROFILES[group.network];
      for (let round = 1; round <= rounds; round += 1) {
        onProgress(`[web-perf] ${group.id} round ${round}/${rounds}`);
        const context = await browser.newContext({ viewport: VIEWPORT });
        try {
          if (group.auth) await login(context, origin, token);
          const page = await context.newPage();
          const state = { errors: [], failedRequests: [], responses: [] };
          page.on("pageerror", error => state.errors.push(sanitizeErrorText(error.message, origin)));
          page.on("requestfailed", request => {
            const url = new URL(request.url());
            if (url.origin !== origin) return;
            if (!["GET", "HEAD"].includes(request.method()) && (url.pathname === "/api" || url.pathname.startsWith("/api/"))) return;
            state.failedRequests.push({
              method: request.method(),
              path: sanitizeResourcePath(url.pathname),
              reason: sanitizeErrorText(request.failure()?.errorText ?? "", origin),
            });
          });
          page.on("response", response => {
            const url = new URL(response.url());
            if (url.origin !== origin) return;
            const headers = response.headers();
            state.responses.push({
              category: responseCategory(url.pathname, response.request().resourceType()),
              status: response.status(),
              encoding: headers["content-encoding"] ?? "identity",
              cacheControl: headers["cache-control"] ?? null,
            });
          });
          await page.addInitScript(installProbe, { selector: group.contentSelector });
          const cdp = await context.newCDPSession(page);
          await cdp.send("Performance.enable");
          if (network.emulated) {
            await cdp.send("Network.enable");
            await cdp.send("Network.emulateNetworkConditions", {
              offline: false,
              latency: network.latencyMs,
              downloadThroughput: network.downloadBytesPerSecond,
              uploadThroughput: network.uploadBytesPerSecond,
            });
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: network.cpuSlowdown });
          }
          const url = urlFor(group, origin, admin.selectedId);
          for (const mode of modes) {
            let result;
            try {
              result = await navigateAndCollect(page, state, {
                url,
                mode,
                settleMs: group.settleMs[mode],
                contentSelector: group.contentSelector,
                timeout: network.emulated ? 45_000 : 20_000,
                origin,
              });
            } catch (error) {
              result = {
                metrics: {},
                navigation: null,
                observedMs: null,
                wallMs: null,
                readyTimeout: true,
                errors: [sanitizeErrorText(error.message, origin)],
                failedRequests: state.failedRequests.splice(0),
                blockedWrites: [],
                serving: aggregateServing(state.responses.splice(0)),
                resources: [],
              };
            }
            if (recorded.has(mode)) {
              const id = scenarioId(group, mode);
              scenarioRounds.get(id).push(result);
              mergeServing(scenarioServing.get(id), result.serving);
            }
          }
        } finally {
          if (group.auth) await logout(context, origin);
          await context.close();
        }
      }
    }
    let endScale = null;
    let endScaleError = null;
    try {
      endScale = await readEndScale(browser, origin, token);
    } catch (error) {
      endScaleError = sanitizeErrorText(error.message, origin);
    }
    const stableDuringRun = endScale ? JSON.stringify(admin.dataScale) === JSON.stringify(endScale) : null;
    const scenarios = {};
    for (const scenario of allScenarios()) {
      const collected = scenarioRounds.get(scenario.id) ?? [];
      if (collected.length === 0) continue;
      scenarios[scenario.id] = {
        view: scenario.view,
        cache: scenario.cache,
        network: scenario.network,
        ...summarizeRounds(collected, { serving: scenarioServing.get(scenario.id) }),
      };
    }
    const runtimeCheck = admin.assets.checks.find(check => check.file === (admin.assets.servedEntry ?? admin.assets.manifestEntry));
    const environment = {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      browser: "chromium",
      browserVersion,
      viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
      headless: true,
      serviceVersion: admin.config.currentVersion ?? null,
      packageVersion: admin.config.packageVersion ?? null,
      loadAverage: startLoadAverage,
      networkProfiles: NETWORK_PROFILES,
      assetChecks: admin.assets.checks,
      buildIntegrity: {
        manifestEntry: admin.assets.manifestEntry,
        servedEntry: admin.assets.servedEntry,
        manifestBuildId: admin.assets.manifestBuildId,
        servedRuntimeMatchesSource: runtimeCheck ? runtimeCheck.sourceMatches === true : false,
        checks: admin.assets.checks,
      },
    };
    return {
      schema: BASELINE_SCHEMA,
      kind: MEASUREMENT_KIND,
      generatedAt: new Date().toISOString(),
      startedAt,
      environment,
      fixture: { ...admin.fixture, stableDuringRun, endScale, endScaleError },
      sources: {
        lab: { available: true, note: "Chrome lab observation from the installed service; not field CWV. INP is not measured." },
        field: { available: false, reason: "No RUM/CrUX collection in this repository; lab medians are not field percentiles." },
      },
      notMeasured: NOT_MEASURED,
      scenarios,
      rounds: Object.fromEntries([...scenarioRounds].filter(([, value]) => value.length > 0)),
    };
  } finally {
    await browser.close();
  }
}

export { readConnection };
