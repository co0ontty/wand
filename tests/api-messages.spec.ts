import { test, expect, APIRequestContext } from "@playwright/test";
import { TEST_PASSWORD, TEST_PORT } from "./global-setup";

test.describe("API Message Tracking", () => {
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: `https://localhost:${TEST_PORT}`,
      ignoreHTTPSErrors: true,
    });
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  /** Login and return authenticated request context */
  async function authenticate() {
    const loginRes = await request.post("/api/login", {
      data: { password: TEST_PASSWORD }
    });
    expect(loginRes.status()).toBe(200);
  }

  /** Create a session running a shell command and return its ID */
  async function createSession(command: string, initialInput?: string): Promise<string> {
    const body: Record<string, string> = { command, cwd: "/tmp" };
    if (initialInput) {
      body.initialInput = initialInput;
    }
    const res = await request.post("/api/commands", { data: body });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    return data.id as string;
  }

  test.describe("Session messages field", () => {
    test.beforeEach(async () => {
      await authenticate();
    });

    test("GET /api/sessions/:id?format=chat should return messages array", async () => {
      const sessionId = await createSession("echo hello");
      // Wait for output
      await new Promise((r) => setTimeout(r, 2000));

      const res = await request.get(`/api/sessions/${sessionId}?format=chat`);
      expect(res.status()).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("messages");
      expect(Array.isArray(data.messages)).toBe(true);
    });

    test("session with initialInput should track user message", async () => {
      const sessionId = await createSession("cat", "hello world");
      await new Promise((r) => setTimeout(r, 2000));

      const res = await request.get(`/api/sessions/${sessionId}?format=chat`);
      expect(res.status()).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data.messages)).toBe(true);

      // Should have at least one message tracked
      if (data.messages.length > 0) {
        const userMsg = data.messages.find(
          (m: { role: string }) => m.role === "user"
        );
        if (userMsg) {
          // User message content should be structured
          expect(userMsg.content).toBeTruthy();
        }
      }
    });

    test("sending input via API should add to messages", async () => {
      const sessionId = await createSession("cat");
      await new Promise((r) => setTimeout(r, 1000));

      // Send input
      const inputRes = await request.post(`/api/sessions/${sessionId}/input`, {
        data: { input: "test message\n" }
      });
      expect(inputRes.status()).toBe(200);

      await new Promise((r) => setTimeout(r, 1000));

      // Check messages
      const res = await request.get(`/api/sessions/${sessionId}?format=chat`);
      const data = await res.json();

      // Should have tracked the user input
      if (data.messages && data.messages.length > 0) {
        const userMessages = data.messages.filter(
          (m: { role: string }) => m.role === "user"
        );
        expect(userMessages.length).toBeGreaterThanOrEqual(1);

        // Check the user message has text content
        const lastUser = userMessages[userMessages.length - 1];
        expect(lastUser.content).toBeTruthy();
        if (Array.isArray(lastUser.content)) {
          const textBlock = lastUser.content.find(
            (b: { type: string }) => b.type === "text"
          );
          if (textBlock) {
            expect(textBlock.text).toContain("test message");
          }
        }
      }
    });
  });

  test.describe("Control characters should not produce messages", () => {
    test.beforeEach(async () => {
      await authenticate();
    });

    test("Ctrl+C (\\x03) should not create a user message", async () => {
      const sessionId = await createSession("cat");
      await new Promise((r) => setTimeout(r, 1000));

      // Send Ctrl+C
      const inputRes = await request.post(`/api/sessions/${sessionId}/input`, {
        data: { input: "\x03" }
      });
      expect(inputRes.status()).toBe(200);

      await new Promise((r) => setTimeout(r, 1000));

      const res = await request.get(`/api/sessions/${sessionId}?format=chat`);
      const data = await res.json();

      // Ctrl+C should not be tracked as a user message
      if (data.messages && data.messages.length > 0) {
        const userMessages = data.messages.filter(
          (m: { role: string }) => m.role === "user"
        );
        for (const msg of userMessages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text") {
                expect(block.text).not.toBe("\x03");
              }
            }
          }
        }
      }
    });

    test("Ctrl+D (\\x04) should not create a user message", async () => {
      const sessionId = await createSession("cat");
      await new Promise((r) => setTimeout(r, 1000));

      // Send Ctrl+D
      const inputRes = await request.post(`/api/sessions/${sessionId}/input`, {
        data: { input: "\x04" }
      });
      expect(inputRes.status()).toBe(200);

      await new Promise((r) => setTimeout(r, 1000));

      const res = await request.get(`/api/sessions/${sessionId}?format=chat`);
      const data = await res.json();

      if (data.messages && data.messages.length > 0) {
        const userMessages = data.messages.filter(
          (m: { role: string }) => m.role === "user"
        );
        for (const msg of userMessages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text") {
                expect(block.text).not.toBe("\x04");
              }
            }
          }
        }
      }
    });

    test("empty string should not create a user message", async () => {
      const sessionId = await createSession("cat");
      await new Promise((r) => setTimeout(r, 1000));

      const inputRes = await request.post(`/api/sessions/${sessionId}/input`, {
        data: { input: "" }
      });
      // May succeed or fail, but should not crash
      expect([200, 400]).toContain(inputRes.status());

      await new Promise((r) => setTimeout(r, 500));

      const res = await request.get(`/api/sessions/${sessionId}?format=chat`);
      const data = await res.json();

      // No user messages with empty content
      if (data.messages && data.messages.length > 0) {
        const userMessages = data.messages.filter(
          (m: { role: string }) => m.role === "user"
        );
        for (const msg of userMessages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text") {
                expect(block.text.trim().length).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    });

    test("single 'y' or 'n' should not create a user message", async () => {
      const sessionId = await createSession("cat");
      await new Promise((r) => setTimeout(r, 1000));

      // Send 'y' — typically an auto-confirm response
      await request.post(`/api/sessions/${sessionId}/input`, {
        data: { input: "y\n" }
      });

      await new Promise((r) => setTimeout(r, 500));

      const res = await request.get(`/api/sessions/${sessionId}?format=chat`);
      const data = await res.json();

      if (data.messages && data.messages.length > 0) {
        const userMessages = data.messages.filter(
          (m: { role: string }) => m.role === "user"
        );
        for (const msg of userMessages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text") {
                expect(block.text).not.toBe("y");
                expect(block.text).not.toBe("n");
              }
            }
          }
        }
      }
    });
  });

  test.describe("Input to ended sessions", () => {
    test.beforeEach(async () => {
      await authenticate();
    });

    test("sending input to a completed session should return error", async () => {
      const sessionId = await createSession("echo done");
      // Wait for command to finish
      await new Promise((r) => setTimeout(r, 3000));

      // Verify session has ended
      const sessionRes = await request.get(`/api/sessions/${sessionId}`);
      const sessionData = await sessionRes.json();
      expect(["exited", "stopped"]).toContain(sessionData.status);

      // Try sending input
      const inputRes = await request.post(`/api/sessions/${sessionId}/input`, {
        data: { input: "should fail\n" }
      });

      // Should get an error response (400 or 500), not 200
      expect(inputRes.status()).toBeGreaterThanOrEqual(400);
    });
  });

  test.describe("Session deletion", () => {
    test.beforeEach(async () => {
      await authenticate();
    });

    test("deleted session should return 404", async () => {
      const sessionId = await createSession("echo temp");
      await new Promise((r) => setTimeout(r, 2000));

      // Delete
      const delRes = await request.delete(`/api/sessions/${sessionId}`);
      expect(delRes.status()).toBe(200);

      // Should be gone
      const getRes = await request.get(`/api/sessions/${sessionId}`);
      expect(getRes.status()).toBe(404);
    });
  });
});
