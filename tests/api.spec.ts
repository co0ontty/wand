import { test, expect, APIRequestContext } from "@playwright/test";
import { TEST_PASSWORD, TEST_PORT } from "./global-setup";

test.describe("API Endpoints", () => {
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

  test.describe("Authentication API", () => {
    test("POST /api/login - should succeed with correct password", async () => {
      const response = await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    test("POST /api/login - should fail with wrong password", async () => {
      const response = await request.post("/api/login", {
        data: { password: "wrong-password" }
      });
      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body.error).toBeTruthy();
    });

    test("POST /api/login - should require password field", async () => {
      const response = await request.post("/api/login", {
        data: {}
      });
      expect(response.status()).toBe(401);
    });
  });

  test.describe("Config API", () => {
    test("GET /api/config - should require auth", async () => {
      const response = await request.get("/api/config");
      expect(response.status()).toBe(401);
    });

    test("GET /api/config - should return config when authenticated", async () => {
      // Login first to get session cookie
      const loginResponse = await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });
      expect(loginResponse.status()).toBe(200);

      const response = await request.get("/api/config");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.host).toBeTruthy();
      expect(body.port).toBeGreaterThan(0);
      expect(body.defaultMode).toBeTruthy();
    });
  });

  test.describe("Sessions API", () => {
    test("GET /api/sessions - should require auth", async () => {
      const response = await request.get("/api/sessions");
      expect(response.status()).toBe(401);
    });

    test("GET /api/sessions - should return sessions array", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.get("/api/sessions");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  test.describe("Path Suggestions API", () => {
    test("GET /api/path-suggestions - should require auth", async () => {
      const response = await request.get("/api/path-suggestions?q=/tmp");
      expect(response.status()).toBe(401);
    });

    test("GET /api/path-suggestions - should return suggestions", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.get("/api/path-suggestions?q=/tmp");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  test.describe("Path Validation API", () => {
    test("GET /api/validate-path - should validate valid path", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.get("/api/validate-path?path=/tmp");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.valid).toBe(true);
      expect(body.resolvedPath).toContain("/tmp");
    });

    test("GET /api/validate-path - should reject invalid path", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.get("/api/validate-path?path=/nonexistent/path/xyz");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.valid).toBe(false);
      expect(body.error).toBeTruthy();
    });
  });

  test.describe("Favorites API", () => {
    test("GET /api/favorites - should return favorites array", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.get("/api/favorites");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
    });

    test("POST /api/favorites - should add favorite", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.post("/api/favorites", {
        data: { path: "/tmp", name: "tmp" }
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    test("DELETE /api/favorites - should remove favorite", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      // Add first
      await request.post("/api/favorites", {
        data: { path: "/tmp/test", name: "test" }
      });

      // Then delete
      const response = await request.delete("/api/favorites", {
        data: { path: "/tmp/test" }
      });
      expect(response.status()).toBe(200);
    });
  });

  test.describe("Recent Paths API", () => {
    test("GET /api/recent-paths - should return recent paths array", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.get("/api/recent-paths");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
    });

    test("POST /api/recent-paths - should add recent path", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.post("/api/recent-paths", {
        data: { path: "/tmp" }
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.path).toBe("/tmp");
    });
  });

  test.describe("Directory API", () => {
    test("GET /api/directory - should return directory contents", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.get("/api/directory?q=.");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
    });

    test("GET /api/folders - should return folder contents", async () => {
      await request.post("/api/login", {
        data: { password: TEST_PASSWORD }
      });

      const response = await request.get("/api/folders?q=/tmp");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });
});