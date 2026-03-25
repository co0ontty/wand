import { test, expect, APIRequestContext } from "@playwright/test";
import {
  createApiContext,
  sendSessionInput,
  waitForOutput,
  getChatMessages,
} from "./api-helpers";

test.describe("User Interaction - API Level", () => {
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await createApiContext(playwright);
    await request.post("/api/login", { data: { password: "test-change-me" } });
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test("should display interactive prompt for read command", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: 'bash -c \'read -p "Your name: " name && echo "Hello $name"\'', cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    const output = await waitForOutput(request, sessionId, "Your name");
    expect(output).toContain("Your name");
  });

  test("should accept user input for interactive prompt", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: 'bash -c \'read -p "Your name: " name && echo "Hello $name"\'', cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    await waitForOutput(request, sessionId, "Your name");
    await sendSessionInput(request, sessionId, "Alice\n");

    const output = await waitForOutput(request, sessionId, "Hello Alice");
    expect(output).toContain("Alice");
  });

  test("should handle y/n confirmation", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: 'bash -c \'read -p "Confirm? (y/n): " ans; if [ "$ans" = "y" ]; then echo "Confirmed"; else echo "Cancelled"; fi\'', cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    await waitForOutput(request, sessionId, "Confirm?");
    await sendSessionInput(request, sessionId, "y\n");

    const output = await waitForOutput(request, sessionId, "Confirmed");
    expect(output).toContain("Confirmed");
  });

  test("should handle n confirmation", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: 'bash -c \'read -p "Confirm? (y/n): " ans; if [ "$ans" = "y" ]; then echo "Confirmed"; else echo "Cancelled"; fi\'', cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    await waitForOutput(request, sessionId, "Confirm?");
    await sendSessionInput(request, sessionId, "n\n");

    const output = await waitForOutput(request, sessionId, "Cancelled");
    expect(output).toContain("Cancelled");
  });

  test("should handle menu selection", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: 'bash -c \'echo "1) Option A"; echo "2) Option B"; echo "3) Option C"; read -p "Choice: " c; case $c in 1) echo "Selected A" ;; 2) echo "Selected B" ;; 3) echo "Selected C" ;; esac\'', cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    const output = await waitForOutput(request, sessionId, "Option C");
    expect(output).toContain("Option A");
    expect(output).toContain("Option B");

    await sendSessionInput(request, sessionId, "2\n");
    await waitForOutput(request, sessionId, "Selected B");
  });

  test("should handle multiple sequential prompts", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: 'bash -c \'read -p "Name: " name; read -p "Age: " age; echo "Hello $name, you are $age"\'', cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    await waitForOutput(request, sessionId, "Name:");
    await sendSessionInput(request, sessionId, "Alice\n");
    await waitForOutput(request, sessionId, "Age:");
    await sendSessionInput(request, sessionId, "25\n");

    const output = await waitForOutput(request, sessionId, "Hello Alice");
    expect(output).toContain("25");
  });

  test("should handle menu with bracket options", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: 'bash -c \'echo "Select option:"; echo "[A] First"; echo "[B] Second"; echo "[C] Third"; read -p "Choice: " c; echo "You chose: $c"\'', cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    const output = await waitForOutput(request, sessionId, "[C]");
    expect(output).toContain("[A]");
    expect(output).toContain("[B]");

    await sendSessionInput(request, sessionId, "B\n");
    await waitForOutput(request, sessionId, "You chose: B");
  });

  test("should handle numeric input response", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: 'bash -c \'read -p "Enter number: " num; echo "Your number is: $num"\'', cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    await waitForOutput(request, sessionId, "Enter number");
    await sendSessionInput(request, sessionId, "42\n");

    const output = await waitForOutput(request, sessionId, "Your number is: 42");
    expect(output).toContain("42");
  });
});

test.describe("User Interaction - Session Tracking", () => {
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await createApiContext(playwright);
    await request.post("/api/login", { data: { password: "test-change-me" } });
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test("should track user input as messages", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: "cat", cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    await new Promise(r => setTimeout(r, 500));
    await sendSessionInput(request, sessionId, "Hello World\n");
    await new Promise(r => setTimeout(r, 500));

    const messages = await getChatMessages(request, sessionId);
    const userMessages = messages.filter(m => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
  });

  test("should track multiple sequential inputs as separate messages", async () => {
    const sessionId = await request.post("/api/commands", {
      data: { command: "cat", cwd: "/tmp" }
    }).then(r => r.json()).then(d => d.id);

    await new Promise(r => setTimeout(r, 500));
    await sendSessionInput(request, sessionId, "First\n");
    await sendSessionInput(request, sessionId, "Second\n");
    await new Promise(r => setTimeout(r, 500));

    const messages = await getChatMessages(request, sessionId);
    const userMessages = messages.filter(m => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });
});