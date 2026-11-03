// Read-only installed-service/package verification. Never prints connection credentials.
import { loginToInstalledService } from "./installed-service-login.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
const { origin, cookie } = await loginToInstalledService();
const get = async path => { const r = await fetch(new URL(path, origin), { headers: { cookie } }); assert.equal(r.status, 200, "installed endpoint response"); return r; };
const results = [];
for (const [platform, route] of [["android", "android-apk"], ["macos", "macos-app"], ["ios", "ios-ipa"]]) {
  const info = await (await get(`/api/${route}-update?currentVersion=0.0.0&channel=beta`)).json();
  const expected = readFileSync(join(root, "output/conversation-filters", `${platform}-version.txt`), "utf8").trim();
  assert.equal(info.latestVersion, expected, platform + " latest package");
  assert.equal(info.source, "local");
  assert.ok(info.downloadUrl && info.fileName);
  const url = new URL(info.downloadUrl, origin);
  // Public download URLs may use the external HTTPS origin. Verify the identical
  // route on this installed service, without exporting credentials to another host.
  const download = await get(url.pathname + url.search);
  const bytes = Buffer.from(await download.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const local = readFileSync(join(process.env.HOME, ".wand", platform, info.fileName));
  assert.equal(bytes.length, info.size);
  assert.equal(sha256, createHash("sha256").update(local).digest("hex"));
  if (info.sha256) assert.equal(sha256, info.sha256);
  if (platform === "ios") assert.equal(info.signed, true);
  results.push({ platform, version: info.latestVersion, file: info.fileName, size: bytes.length, sha256, signed: info.signed ?? null, downloadVerified: true });
}
const taskResponse = await (await get("/api/tasks?includeArchived=1")).json();
const groups = Array.isArray(taskResponse) ? taskResponse : taskResponse.groups;
const tasks = groups.flatMap(group => group.tasks);
const service = { taskCount: tasks.length, boardStatusProjected: tasks.length > 0 && tasks.every(task => Object.hasOwn(task, "boardTaskStatus")) };
const report = { packagesVerified: true, results, installedService: service, deviceInstalled: false, serviceRestarted: false };
writeFileSync(join(root, "output/conversation-filters/delivery-verification.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
