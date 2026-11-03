import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export async function loginToInstalledService(signal) {
  const connection = JSON.parse(readFileSync(join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
  const response = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appToken: decoded.slice(decoded.lastIndexOf("#") + 1) }),
    signal,
  });
  assert.equal(response.status, 200, "installed service login");
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.map(value => value.split(";")[0]).join("; ");
  return { origin, cookies, cookie };
}
