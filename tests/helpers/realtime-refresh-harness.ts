import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ComposerStore } from "../../src/web-ui/browser/composer.js";
import { createSessionReads } from "../../src/web-ui/browser/session-reads.js";
import * as reconciliation from "../../src/web-ui/browser/message-reconciliation.js";
import * as agentRuns from "../../src/web-ui/browser/agent-runs.js";
import { parseJsonResponse } from "../../src/web-ui/react/http-adapter.js";

const compiled = new Map<string, string>();
const noop = () => {};
const fallback = new Proxy({}, { get: () => noop });
export function loadRealtimeBrowserModule(file: string, dependencies: Record<string, any>, globals: Record<string, any>): Record<string, any> {
  let code = compiled.get(file);
  if (!code) {
    code = ts.transpileModule(readFileSync(new URL(`../../src/web-ui/browser/${file}.ts`, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    compiled.set(file, code);
  }
  const api: Record<string, any> = {};
  const pureModules = new Map<string, Record<string, any>>();
  runInNewContext(code, { exports: api, require: (id: string) => {
    if (dependencies[id]) return dependencies[id];
    const pure = /^\.\/(chat-render-cache|chat-render-signature)(?:\.js)?$/.exec(id)?.[1];
    if (pure) {
      if (!pureModules.has(pure)) pureModules.set(pure, loadRealtimeBrowserModule(pure, dependencies, globals));
      return pureModules.get(pure);
    }
    return fallback;
  }, ...globals });
  return api;
}

export const textTurn = (text: string, role = "assistant", extra: Record<string, any> = {}) => ({
  role, createdAt: "2026-09-30T00:00:00Z", content: [{ type: "text", text }], ...extra,
});
export const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Synthetic DOM and message renderer: exercises real render control flow, not browser layout. */
export function createRealtimeRenderHarness() {
  let failWrite = false;
  let failFrameSchedule = false;
  let fullWrites = 0;
  const rendered: number[] = [];
  const errors: unknown[] = [];
  class Element {
    className = ""; attributes = new Map<string, string>(); children: Element[] = [];
    scrollTop = 0; isConnected = true; private html = "";
    classList = { add: (_name: string) => {}, contains: () => false, toggle: () => {} };
    get innerHTML() { return this.html; }
    set innerHTML(value: string) {
      if (failWrite) { failWrite = false; throw new Error("injected DOM write failure"); }
      this.html = value;
      if (this.className === "chat-messages") fullWrites++;
      this.children = [];
      for (const match of value.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div>/g)) {
        const className = /class="(chat-message[^"]*)"/.exec(match[1]);
        if (!className) continue;
        const child = new Element(); child.className = className[1]; child.html = match[2];
        const index = /data-msg-index="(\d+)"/.exec(match[1]);
        if (index) child.attributes.set("data-msg-index", index[1]);
        this.children.push(child);
      }
    }
    get firstElementChild() { return this.children[0] || null; }
    get firstChild() { return this.firstElementChild; }
    querySelectorAll(selector: string) { return selector.startsWith(".chat-message") ? this.children : []; }
    querySelector(selector: string) {
      if (selector === ".chat-messages") return this.children.find(c => c.className === "chat-messages") || null;
      const index = /data-msg-index="(\d+)"/.exec(selector);
      return index ? this.children.find(c => c.getAttribute("data-msg-index") === index[1]) || null : null;
    }
    appendChild(child: Element) { this.children.push(child); return child; }
    replaceChild(next: Element, prev: Element) { this.children[this.children.indexOf(prev)] = next; return prev; }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    getAttribute(key: string) { return this.attributes.get(key) ?? null; }
    getBoundingClientRect() { return { top: 0, bottom: 100 }; }
    addEventListener() {} removeEventListener() {}
  }
  const output = new Element(), messages = new Element(); messages.className = "chat-messages"; output.appendChild(messages);
  const frames: Array<() => void> = [];
  const state: Record<string, any> = { selectedId: "A", sessions: [], currentMessages: [], chatRenderedCount: 20,
    chatPageSize: 20, lastRenderedMsgCount: 0,
    chatStickToBottom: false, chatInitialRenderDone: true, chatUnreadCount: 0, chatUnreadStartIndex: -1, config: {}, renderPending: false };
  const globals = { window: { addEventListener: noop, matchMedia: () => ({ matches: false }) },
    document: { addEventListener: noop, getElementById: (id: string) => id === "chat-output" ? output : null,
      querySelector: () => null, createElement: () => new Element() },
    console: { error: (...args: unknown[]) => errors.push(args) },
    requestAnimationFrame: (fn: () => void) => {
      if (failFrameSchedule) { failFrameSchedule = false; throw new Error("injected frame scheduling failure"); }
      frames.push(fn); return frames.length;
    },
    setTimeout: noop, clearTimeout: noop, fetch: () => new Promise(() => {}),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    fixtureRenderer: (msg: any, usage: any, index: number, _runs: any, results: any, grouped: boolean) => {
      rendered.push(index);
      const body = JSON.stringify({ msg, usage, results, grouped: !!grouped }).replace(/</g, "&lt;");
      return `<div class="chat-message ${msg.role}" data-msg-index="${index}">${body}</div>`;
    },
  };
  const dependencies = { "./state": { state }, "./agent-runs": agentRuns,
    "./chat-scroll": new Proxy({ isChatNearBottom: () => false }, { get: (o: any, k: string) => o[k] ?? noop }),
    "./pty-system-info": { shouldExtractPtySystemInfo: () => false },
    "./i18n": { getActiveLang: () => "zh", t: (v: string) => v, iconSvg: () => "" } };
  // Only substitute rendering/layout helpers; leave doRenderChat and scheduler untouched.
  const source = readFileSync(new URL("../../src/web-ui/browser/chat-render.ts", import.meta.url), "utf8") + `\n
    renderChatMessage = fixtureRenderer;
    applyHistoryCollapse = function() {};
    applyAutoFoldBar = function() {};
    updateTodoProgress = function() {};
    attachAllCopyHandlers = function() {};
    attachCopyHandler = function() {};
  `;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const chat: any = {};
  runInNewContext(code, { exports: chat, ...globals, require: (id: string) => {
    const pure = /^\.\/(chat-render-cache|chat-render-signature)(?:\.js)?$/.exec(id)?.[1];
    return pure ? loadRealtimeBrowserModule(pure, {}, globals) : (dependencies as any)[id] ?? fallback;
  } });
  const render = loadRealtimeBrowserModule("render", dependencies, globals);
  const setMessages = (turns: any[]) => {
    state.currentMessages = turns;
    state.sessions = [{ id: state.selectedId, sessionKind: "structured", status: "idle", structuredState: { inFlight: false }, messages: turns }];
  };
  const flush = () => { const work = frames.splice(0); for (const fn of work) { try { fn(); } catch (e) { errors.push(e); } } };
  const bodyAt = (index: number) => messages.children.find(c => c.getAttribute("data-msg-index") === String(index))?.innerHTML ?? "";
  return { state, chat, render, frames, errors, rendered, messages, setMessages, flush, bodyAt,
    failNextWrite: () => { failWrite = true; }, failNextFrameSchedule: () => { failFrameSchedule = true; },
    fullWrites: () => fullWrites };
}

export function createRealtimeSessionHarness() {
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; sent: string[] = [];
    onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor(_url: string) { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const sockets: Socket[] = [], errors: unknown[] = [];
  const state: Record<string, any> = { selectedId: "A", sessions: [], currentMessages: [], config: {},
    ws: null, lastSeqBySession: {}, crossSessionQueue: [], pendingMessages: [], messageQueue: [],
    structuredInputQueue: [], terminalStatesBySession: {}, currentView: "chat", turnActiveBySession: {} };
  const requests: Array<{ url: string; resolve: (response: Response) => void }> = [];
  const composer = new ComposerStore({ storage: () => ({ getItem: () => null, setItem: noop, removeItem: noop }), isUnloading: () => false });
  const globals = { window: { WebSocket: Socket, location: { protocol: "http:", host: "example.test" }, addEventListener: noop },
    document: { hidden: false, addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    WebSocket: Socket, Response, console: { error: (...args: unknown[]) => errors.push(args) },
    fetch: (url: string) => new Promise<Response>(resolve => requests.push({ url, resolve })),
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop } };
  const dependencies = { "./state": { state, composer, composerQueue: { advance: noop }, writeStoredBoolean: noop },
    "./session-reads": { createSessionReads }, "./message-reconciliation": reconciliation,
    "../react/http-adapter": { parseJsonResponse },
    "./input": new Proxy({ buildMessagesForRender: (_s: any, turns: any) => turns }, { get: (o: any, k: string) => o[k] ?? noop }),
    "./chat-scroll": new Proxy({ normalizeStructuredSnapshot: (s: any) => s, stripRenderOnlyStructuredMessages: (m: any) => m }, { get: (o: any, k: string) => o[k] ?? noop }) };
  const engine = loadRealtimeBrowserModule("session-engine", dependencies, globals);
  const ws = loadRealtimeBrowserModule("websocket", { ...dependencies, "./session-engine": engine }, globals);
  ws.initWebSocket(); const socket = sockets[0]; socket.readyState = 1; socket.onopen!();
  const send = (frame: any, owner = socket) => owner.onmessage!({ data: JSON.stringify(frame) });
  const respond = (i: number, body: unknown) => requests[i].resolve(new Response(JSON.stringify(body), { status: 200 }));
  return { state, engine, ws, socket, sockets, send, requests, respond, errors, composer,
    resyncs: () => socket.sent.filter(value => JSON.parse(value).type === "resync") };
}
