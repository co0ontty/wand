import { expect, APIRequestContext, Playwright } from "@playwright/test";
import { TEST_PASSWORD, TEST_PORT } from "./global-setup";

export async function createApiContext(playwright: Playwright): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL: `https://localhost:${TEST_PORT}`,
    ignoreHTTPSErrors: true,
  });
}

export async function authenticate(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/login", {
    data: { password: TEST_PASSWORD }
  });
  expect(res.status()).toBe(200);
}

export async function createSession(
  request: APIRequestContext,
  command: string,
  cwd: string = "/tmp"
): Promise<string> {
  const res = await request.post("/api/commands", {
    data: { command, cwd }
  });
  expect([200, 201]).toContain(res.status());
  const data = await res.json();
  expect(data.id).toBeTruthy();
  expect(data.status).toBe("running");
  return data.id;
}

export async function getSessionOutput(
  request: APIRequestContext,
  sessionId: string
): Promise<string> {
  const res = await request.get(`/api/sessions/${sessionId}`);
  expect(res.status()).toBe(200);
  const data = await res.json();
  return data.output as string;
}

export async function getChatMessages(
  request: APIRequestContext,
  sessionId: string
): Promise<Array<{ role: string }>> {
  const res = await request.get(`/api/sessions/${sessionId}?format=chat`);
  expect(res.status()).toBe(200);
  const data = await res.json();
  return data.messages || [];
}

export async function sendSessionInput(
  request: APIRequestContext,
  sessionId: string,
  input: string
): Promise<void> {
  const res = await request.post(`/api/sessions/${sessionId}/input`, {
    data: { input }
  });
  expect(res.status()).toBe(200);
}

export async function stopSession(
  request: APIRequestContext,
  sessionId: string
): Promise<void> {
  await request.post(`/api/sessions/${sessionId}/stop`);
}

export async function deleteSession(
  request: APIRequestContext,
  sessionId: string
): Promise<void> {
  await request.delete(`/api/sessions/${sessionId}`);
}

export async function waitForOutput(
  request: APIRequestContext,
  sessionId: string,
  expected: string | RegExp,
  timeout = 5000
): Promise<string> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const output = await getSessionOutput(request, sessionId);
    if (typeof expected === "string" ? output.includes(expected) : expected.test(output)) {
      return output;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  const output = await getSessionOutput(request, sessionId);
  throw new Error(`Timeout waiting for output matching "${expected}". Last output: ${output.slice(0, 500)}`);
}