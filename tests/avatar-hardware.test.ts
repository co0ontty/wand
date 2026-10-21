import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_LIVE_MIN_CORES, AVATAR_LIVE_MIN_MEMORY_GB, AVATAR_LIVE_MIN_TEXTURE,
  avatarRenderChoice, type AvatarHardwareFacts,
} from "../src/web-ui/avatar-hardware.js";

const capable: AvatarHardwareFacts = {
  cores: AVATAR_LIVE_MIN_CORES, memoryGb: AVATAR_LIVE_MIN_MEMORY_GB,
  webgl: true, webglWithoutCaveat: true, maxTextureSize: AVATAR_LIVE_MIN_TEXTURE,
};

test("live head requires the browser's own hardware facts, not a GPU name", () => {
  assert.equal(avatarRenderChoice(capable), "live");
  assert.equal(avatarRenderChoice({ ...capable, cores: undefined, memoryGb: undefined }), "live", "withheld optional facts are not weakness");
  assert.equal(avatarRenderChoice({ ...capable, webglWithoutCaveat: false }), "static", "major performance caveat stays flat");
  assert.equal(avatarRenderChoice({ ...capable, webgl: false, webglWithoutCaveat: false, maxTextureSize: 0 }), "static");
  assert.equal(avatarRenderChoice({ ...capable, maxTextureSize: AVATAR_LIVE_MIN_TEXTURE - 1 }), "static");
  assert.equal(avatarRenderChoice({ ...capable, cores: AVATAR_LIVE_MIN_CORES - 1 }), "static");
  assert.equal(avatarRenderChoice({ ...capable, memoryGb: AVATAR_LIVE_MIN_MEMORY_GB - 1 }), "static");
});
