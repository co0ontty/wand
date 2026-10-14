import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { SessionMetadataService } from "../src/session-metadata-service.js";
import { SessionNativeTitleTracker, type SessionTopicCoordinator, type SessionTopicRequest } from "../src/session-topic.js";
import type { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

function harness() {
  let disposed = false;
  let snapshot: SessionSnapshot | undefined = {
    id: "metadata-test", command: "pi", provider: "pi", cwd: "/tmp/topic-workspace", mode: "default",
    status: "running", createdAt: new Date().toISOString(), output: "", exitCode: null,
  };
  const native = new SessionNativeTitleTracker();
  const commits: Array<{ title: string; description: string }> = [];
  const requests: SessionTopicRequest[] = [];
  const coordinator = { request: (_id: string, request: SessionTopicRequest) => requests.push(request) } as unknown as SessionTopicCoordinator;
  const storage = {
    getWorkspaceTask: () => null,
    getWorkspace: () => null,
    getSystemSiliconEmployee: () => null,
  } as unknown as WandStorage;
  const service = new SessionMetadataService({
    isDisposed: () => disposed,
    current: () => snapshot,
    messagesOf: () => [],
    commitTopic: (_id, title, description) => {
      commits.push({ title, description });
      if (snapshot) Object.assign(snapshot, { title, description });
    },
    commitTopicGenerating() {},
    topicCoordinator: () => coordinator,
    nativeTitles: () => native,
  }, { config: defaultConfig(), storage, logPrefix: "[metadata-test]" });
  return { service, native, commits, requests, dispose: () => { disposed = true; }, remove: () => { snapshot = undefined; } };
}

test("shared topic service seeds prompt title and accepts a later generated title", () => {
  const h = harness();
  h.service.generateTopicForPrompt("metadata-test", "分析项目构建失败原因并修复");
  assert.equal(h.commits[0].title, "分析项目构建失败原因并修复");
  assert.equal(h.requests.length, 1);
  h.requests[0].onTopic({ title: "修复构建", description: "定位并修复构建失败" });
  assert.equal(h.commits.at(-1)?.title, "修复构建");
});

test("native titles take precedence and late callbacks do not revive removed/disposed sessions", () => {
  for (const terminal of ["remove", "dispose"] as const) {
    const h = harness();
    h.service.generateTopicForPrompt("metadata-test", "分析项目构建失败原因并修复");
    h.requests[0].onTopic({ title: "原生命名", description: "原生命名", source: "native" });
    h.requests[0].onTopic({ title: "模型迟到", description: "不应覆盖" });
    assert.equal(h.commits.at(-1)?.title, "原生命名");
    const count = h.commits.length;
    h[terminal]();
    h.requests[0].onTopic({ title: "删除后迟到", description: "不应写入", source: "native" });
    assert.equal(h.commits.length, count);
  }
});
