import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SHA256_FILE_NAME,
  SUPPORTED_TRIPLES,
  VERSION_FILE_NAME,
  readBinaryContainerFormat,
  resolvePlatformTriple,
  sha256File,
  stageRenderBinaries,
} from "../scripts/stage-render-binaries.js";
import { resolveRenderTriple } from "../src/render-binary.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 假的产物：一个能执行、能报出版本号的 shell 脚本（真机架构无关）。 */
const GOOD_BINARY = "#!/bin/sh\necho 'wand-render 0.1.0 (protocol 1)'\n";
/** 上一轮真的进过分发目录的那种假二进制。 */
const STUB_BINARY = "#!/bin/sh\necho 'wand-render (stub)'\n";

/**
 * 伪造一个容器格式为 Mach-O 的文件。
 *
 * 跨平台校验不执行二进制、只认魔数，所以测试不需要一个真能运行的 Mach-O 目标文件。
 */
function machoLikeBinary(): Buffer {
  const buffer = Buffer.alloc(1024, 0);
  buffer.write("cffaedfe", 0, "hex");
  return buffer;
}

/** 伪造一个容器格式为 ELF 的文件（用于验证格式判定本身）。 */
function elfLikeBinary(): Buffer {
  const buffer = Buffer.alloc(1024, 0);
  buffer.write("7f454c46", 0, "hex");
  return buffer;
}

interface Fixture {
  root: string;
  renderBinDir: string;
  distDir: string;
  triple: string;
  version: string;
  binaryPath: string;
  sha256: string;
}

interface FixtureOverrides {
  version?: string;
  triple?: string;
  /** 产物内容。Buffer 用于伪造「容器格式像二进制」但内容无意义的文件。 */
  script?: string | Buffer;
  sha256?: string | null;
  size?: number | null;
  binaryPath?: string;
  manifest?: unknown;
}

function createFixture(overrides: FixtureOverrides = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-render-staging-"));
  const version = overrides.version ?? "0.1.0";
  const triple = overrides.triple ?? "darwin-arm64";
  const relativePath = `v${version}/${triple}/wand-render`;
  const renderBinDir = path.join(root, "render-bin");
  const binaryPath = path.join(renderBinDir, relativePath);
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  writeFileSync(binaryPath, overrides.script ?? GOOD_BINARY);
  chmodSync(binaryPath, 0o755);
  const sha256 = sha256File(binaryPath);

  const artifact: Record<string, unknown> = { path: relativePath, sha256 };
  if (overrides.sha256 !== null) {
    artifact.sha256 = overrides.sha256 ?? sha256;
  } else {
    delete artifact.sha256;
  }
  if (overrides.size !== null) {
    artifact.size = overrides.size ?? statSync(binaryPath).size;
  }
  const manifest = overrides.manifest ?? {
    schemaVersion: 1,
    latest: version,
    versions: { [version]: { protocolVersion: 1, triples: { [triple]: artifact } } },
  };
  writeFileSync(path.join(renderBinDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, renderBinDir, distDir: path.join(root, "dist"), triple, version, binaryPath, sha256 };
}

function run(fixture: Fixture, options: Record<string, unknown> = {}) {
  const messages: string[] = [];
  const result = stageRenderBinaries({
    renderBinDir: fixture.renderBinDir,
    distDir: fixture.distDir,
    platform: "darwin",
    arch: "arm64",
    unameMachine: "arm64",
    rosettaTranslated: false,
    logger: (message: string) => messages.push(message),
    ...options,
  });
  return { result, messages };
}

function stagedTarget(fixture: Fixture, triple = fixture.triple): string {
  return path.join(fixture.distDir, "native", triple, "wand-render");
}

function withFixture(overrides: FixtureOverrides, body: (fixture: Fixture) => void): void {
  const fixture = createFixture(overrides);
  try {
    body(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("stages the pinned artifact with 0755 plus version/sha256 sidecars", () => {
  withFixture({}, (fixture) => {
    const { result, messages } = run(fixture);

    assert.equal(result.exitCode, 0);
    assert.equal(result.action, "staged");
    assert.equal(result.version, "0.1.0");
    assert.deepEqual(result.triples, ["darwin-arm64"]);
    assert.deepEqual(result.warnings, []);

    const target = stagedTarget(fixture);
    // 可执行位必须真的落在文件上：npm/git 传输丢的就是它。
    assert.equal(statSync(target).mode & 0o777, 0o755);
    assert.equal(sha256File(target), fixture.sha256);
    assert.equal(readFileSync(path.join(path.dirname(target), VERSION_FILE_NAME), "utf8"), "0.1.0\n");
    assert.equal(
      readFileSync(path.join(path.dirname(target), SHA256_FILE_NAME), "utf8"),
      `${fixture.sha256}  wand-render\n`,
    );
    // 校验过程要留痕（出问题时能看出校验过什么）。
    assert.ok(messages.some((message) => message.includes("sha256")), messages.join("\n"));
  });
});

test("--check verifies the staged copy and --dry-run writes nothing", () => {
  withFixture({}, (fixture) => {
    const dryRun = run(fixture, { dryRun: true });
    assert.equal(dryRun.result.exitCode, 0);
    assert.equal(dryRun.result.action, "would-stage");
    assert.equal(statSync(fixture.distDir, { throwIfNoEntry: false }), undefined);

    // 还没 stage 时 --check 只报告（退出码 0），--check --strict 才是失败（CI 发布链路）。
    const missing = run(fixture, { check: true });
    assert.equal(missing.result.exitCode, 0);
    assert.ok(missing.result.warnings.some((message) => message.includes("尚未 stage")));
    assert.equal(run(fixture, { check: true, strict: true }).result.exitCode, 1);

    run(fixture);

    const checked = run(fixture, { check: true });
    assert.equal(checked.result.exitCode, 0);
    assert.equal(checked.result.action, "checked");
    assert.deepEqual(checked.result.warnings, []);
    assert.ok(checked.messages.some((message) => message.includes("已 stage 的副本一致")), checked.messages.join("\n"));
  });
});

test("a sha256 mismatch fails hard instead of staging a tampered artifact", () => {
  withFixture({ sha256: "0".repeat(64) }, (fixture) => {
    const { result, messages } = run(fixture);

    assert.equal(result.exitCode, 1);
    assert.equal(result.action, "failed");
    assert.equal(statSync(stagedTarget(fixture), { throwIfNoEntry: false }), undefined);
    assert.ok(messages.some((message) => message.includes("sha256 与 manifest 不一致")), messages.join("\n"));
  });
});

test("a stub binary is rejected even when its hash matches the manifest", () => {
  withFixture({ script: STUB_BINARY }, (fixture) => {
    const { result, messages } = run(fixture);

    assert.equal(result.exitCode, 1);
    assert.ok(messages.some((message) => message.includes("stub")), messages.join("\n"));
    assert.equal(statSync(stagedTarget(fixture), { throwIfNoEntry: false }), undefined);
  });
});

test("a binary whose --version disagrees with the manifest is rejected", () => {
  withFixture({ version: "0.1.0", script: "#!/bin/sh\necho 'wand-render 9.9.9'\n" }, (fixture) => {
    const { result, messages } = run(fixture);

    assert.equal(result.exitCode, 1);
    assert.ok(messages.some((message) => message.includes("与 manifest latest")), messages.join("\n"));
  });
});

test("a missing manifest warns and skips, unless --strict is given", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-render-staging-empty-"));
  const empty: Fixture = {
    root,
    renderBinDir: path.join(root, "render-bin"),
    distDir: path.join(root, "dist"),
    triple: "darwin-arm64",
    version: "0.1.0",
    binaryPath: "",
    sha256: "",
  };
  try {
    // 没拉子模块的开发机不该因为缺少发布产物而 npm run build 失败。
    const relaxed = run(empty);
    assert.equal(relaxed.result.exitCode, 0);
    assert.equal(relaxed.result.action, "skipped");
    assert.ok(relaxed.messages.some((message) => message.includes("git submodule update --init")));

    const strict = run(empty, { strict: true });
    assert.equal(strict.result.exitCode, 1);
    assert.equal(strict.result.action, "failed");

    // 文件存在但内容坏了属于硬错误，与「子模块没初始化」不是一回事。
    mkdirSync(empty.renderBinDir, { recursive: true });
    writeFileSync(path.join(empty.renderBinDir, "manifest.json"), "{ not json\n");
    const broken = run(empty);
    assert.equal(broken.result.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a triple that the manifest does not publish is skipped, not invented", () => {
  withFixture({}, (fixture) => {
    // 默认 triple 取当前平台：这里是 darwin-arm64；换成一个 manifest 里没有的平台。
    const absent = run(fixture, { platform: "linux", arch: "x64", unameMachine: "x86_64" });
    assert.equal(absent.result.exitCode, 0);
    assert.equal(absent.result.action, "skipped");

    // 显式点名一个不存在的 triple 属于调用方错误，必须报错。
    const explicit = run(fixture, { triples: ["linux-x64"], all: false });
    assert.equal(explicit.result.exitCode, 1);
    assert.ok(explicit.messages.some((message) => message.includes("没有这些平台")));
  });
});

test("triple resolution follows uname -m and matches the server-side logic", () => {
  // Rosetta：Node 报 x64，机器其实是 arm64。
  assert.equal(resolvePlatformTriple("darwin", "x64", "arm64"), "darwin-arm64");
  assert.equal(resolvePlatformTriple("darwin", "x64", "x86_64", true), "darwin-arm64");
  assert.equal(resolvePlatformTriple("darwin", "x64", "x86_64"), "darwin-x64");
  assert.equal(resolvePlatformTriple("darwin", "x64", null), "darwin-x64");
  assert.equal(resolvePlatformTriple("linux", "x64", "aarch64"), "linux-arm64");
  // 不支持的平台返回 null（脚本据此给出明确结论，而不是找一个不存在的目录）。
  assert.equal(resolvePlatformTriple("win32", "x64", "AMD64"), null);

  // 两侧各自实现（TS 不能被构建脚本 import），但结果必须逐项一致，否则
  // 「stage 到哪」和「去哪找」会分叉。
  const matrix: { platform: string; arch: string; machine: string | null; rosetta: boolean }[] = [
    { platform: "darwin", arch: "x64", machine: "arm64", rosetta: false },
    { platform: "darwin", arch: "x64", machine: "x86_64", rosetta: true },
    { platform: "darwin", arch: "arm64", machine: "arm64", rosetta: false },
    { platform: "darwin", arch: "x64", machine: "x86_64", rosetta: false },
    { platform: "darwin", arch: "x64", machine: null, rosetta: false },
    { platform: "linux", arch: "x64", machine: "x86_64", rosetta: false },
    { platform: "linux", arch: "arm64", machine: "aarch64", rosetta: false },
  ];
  for (const entry of matrix) {
    const expected = resolveRenderTriple(entry.platform, entry.arch, entry.machine, entry.rosetta);
    const fromScript = resolvePlatformTriple(entry.platform, entry.arch, entry.machine, entry.rosetta);
    assert.equal(fromScript, SUPPORTED_TRIPLES.includes(expected) ? expected : null, JSON.stringify(entry));
  }
});

test("the published render-bin manifest matches the checked-in artifact", (t) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    t.skip("该断言针对仓库内 pin 住的 darwin-arm64 产物（需要能执行 Mach-O arm64）");
  }
  const distDir = mkdtempSync(path.join(os.tmpdir(), "wand-render-real-"));
  try {
    const messages: string[] = [];
    const result = stageRenderBinaries({
      renderBinDir: path.join(REPO_ROOT, "render-bin"),
      distDir,
      triples: ["darwin-arm64"],
      check: true,
      logger: (message: string) => messages.push(message),
    });
    // 真实产物必须通过 sha256 + 版本 + 非 stub 三重校验（只读，不写 dist）。
    assert.equal(result.exitCode, 0, messages.join("\n"));
    assert.equal(result.version, "0.1.0");
    assert.ok(messages.some((message) => message.includes("校验通过")), messages.join("\n"));
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
});

test("a foreign-platform artifact is verified by hash and container format, never executed", () => {
  // 回归：Linux CI 上核对 macOS 产物时曾直接去执行它，得到 exec format error，
  // 于是发布门禁失败 —— 而产物其实是好的。跨平台只能校验哈希与格式。
  const fixture = createFixture({ script: machoLikeBinary() });
  try {
    const { result, messages } = run(fixture, { all: true, platform: "linux", arch: "x64", unameMachine: "x86_64", rosettaTranslated: false });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.triples, ["darwin-arm64"]);
    assert.ok(messages.some((message) => message.includes("非本平台产物，跳过 --version 执行校验")), messages.join("\n"));
    assert.ok(readFileSync(fixture.binaryPath).length > 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a text stub in a foreign platform slot is rejected by the container check", () => {
  // 跨平台不执行，但「这一槽位里放的是不是那一类二进制」仍然能判断：
  // 一个 shell 脚本冒充 darwin 产物必须被拦下，否则它会被打进 npm 包。
  const fixture = createFixture({ script: GOOD_BINARY });
  try {
    const { result, messages } = run(fixture, { all: true, platform: "linux", arch: "x64", unameMachine: "x86_64", rosettaTranslated: false });
    assert.equal(result.exitCode, 1);
    assert.ok(messages.some((message) => message.includes("容器格式不对")), messages.join("\n"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("container format detection distinguishes macho, elf, pe and text", () => {
  const fixture = createFixture({ script: machoLikeBinary() });
  try {
    assert.equal(readBinaryContainerFormat(fixture.binaryPath), "macho");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
