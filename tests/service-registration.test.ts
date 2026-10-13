import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { currentServiceManager } from "../src/service-manager/index.js";

test("service registration uses platform-specific scope paths and refuses unsupported platforms", () => {
  const linux = currentServiceManager("linux");
  assert.ok(linux);
  assert.equal(linux.unitPath("system"), "/etc/systemd/system/wand.service");
  assert.equal(linux.unitPath("user"), path.join(os.homedir(), ".config/systemd/user/wand.service"));
  const darwin = currentServiceManager("darwin");
  assert.ok(darwin);
  assert.equal(darwin.unitPath("system"), "/Library/LaunchDaemons/com.wand.web.plist");
  assert.equal(darwin.unitPath("user"), path.join(os.homedir(), "Library/LaunchAgents/com.wand.web.plist"));
  assert.equal(currentServiceManager("win32"), null);
});
