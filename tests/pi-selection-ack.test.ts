import assert from "node:assert/strict";
import test from "node:test";
import { defaultPiCliSessionSettings, piResourceSettingsConfirmed, type PiSessionSettings } from "../src/pi-session-settings.js";

const skill = (n: string): string => `skill-${n.repeat(24)}`;
const mcp = `mcp-${"d".repeat(24)}`;
const before = (): PiSessionSettings => ({ ...defaultPiCliSessionSettings(),
  resources: { skills: [skill("a"), skill("b"), skill("c")], mcpServers: [mcp] },
  lockedSkills: [skill("a"), skill("b")] });

test("unlock acknowledgement accepts only the newly unlocked Skill being deselected", () => {
  const current = before();
  for (const withResources of [false, true]) {
    const patch = { lockedSkills: [skill("b")], ...(withResources ? { resources: current.resources } : {}) };
    const confirmed = { ...current, lockedSkills: patch.lockedSkills };
    assert.ok(piResourceSettingsConfirmed(current, patch, confirmed), "installed Skill stays enabled");
    assert.ok(piResourceSettingsConfirmed(current, patch, { ...confirmed,
      resources: { skills: [skill("b"), skill("c")], mcpServers: [mcp] } }), "server removed the now unavailable unlocked Skill");
    for (const skills of [[skill("a"), skill("c")], [skill("b")], [skill("b"), skill("c"), skill("f")]]) {
      assert.equal(piResourceSettingsConfirmed(current, patch, { ...confirmed,
        resources: { skills, mcpServers: [mcp] } }), false, "other choices cannot be dropped or added");
    }
    assert.equal(piResourceSettingsConfirmed(current, patch, { ...confirmed,
      resources: { skills: [skill("b"), skill("c")], mcpServers: [] } }), false);
    assert.equal(piResourceSettingsConfirmed(current, patch, current), false, "old lock receipt cannot masquerade as saved");
  }
});

test("unrelated edits and already unlocked Skills do not permit selection cleanup", () => {
  const current = before();
  const lost = { ...current, resources: { skills: [skill("b"), skill("c")], mcpServers: [mcp] } };
  assert.equal(piResourceSettingsConfirmed(current, { resources: current.resources }, lost), false);
  assert.equal(piResourceSettingsConfirmed(current, { lockedSkills: current.lockedSkills }, lost), false);
  const unlocked = { ...current, lockedSkills: [] };
  assert.equal(piResourceSettingsConfirmed(unlocked, { lockedSkills: [] }, { ...lost, lockedSkills: [] }), false);
});

test("malformed resource acknowledgements remain failures after unlock", () => {
  const current = before();
  const patch = { resources: current.resources, lockedSkills: [skill("b")] };
  for (const resources of [undefined, null, {}, { skills: [skill("b"), skill("b"), skill("c")], mcpServers: [mcp] },
    { skills: [skill("c"), skill("b")], mcpServers: [mcp] }, { skills: [skill("b"), skill("c")], mcpServers: [mcp, mcp] }]) {
    assert.equal(piResourceSettingsConfirmed(current, patch, { ...current, lockedSkills: patch.lockedSkills,
      resources } as PiSessionSettings), false);
  }
  assert.equal(piResourceSettingsConfirmed(current, patch, undefined), false);
});
