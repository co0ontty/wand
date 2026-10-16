import assert from "node:assert/strict";
import test from "node:test";

test("saved identity wins over late profile reads and historical user authors", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  const events = new EventTarget();
  let release: (response: Response) => void = () => {};
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  globalThis.fetch = () => new Promise<Response>(resolve => { release = resolve; });
  try {
    const { userProfileStore, currentUserAuthor, selfAuthorFor } = await import("../src/web-ui/react/user-profile-repository.js");
    userProfileStore.refresh();
    events.dispatchEvent(new CustomEvent("wand-settings-config-saved", { detail: {
      userProfile: { name: "新资料", avatar: "plush:v1:round:cream:none:beanie" },
    } }));
    release(Response.json({ userProfile: { name: "过期资料", avatar: "cat:1" } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(userProfileStore.getSnapshot().name, "新资料");
    assert.equal(currentUserAuthor().id, "user");
    assert.equal(currentUserAuthor().avatar, "plush:v1:round:cream:none:beanie");
    assert.deepEqual(selfAuthorFor({ role: "user", author: { id: "user", name: "旧历史署名" } }), currentUserAuthor());
    assert.deepEqual(Object.keys(currentUserAuthor()).sort(), ["avatar", "id", "name"], "展示身份不附加执行能力");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
