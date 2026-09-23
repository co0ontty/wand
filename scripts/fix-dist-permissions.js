import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** 给已存在的文件补可执行位（缺失就跳过：这个脚本在部分构建路径里跑在文件生成之前）。 */
function ensureExecutable(target) {
  if (!existsSync(target)) return;
  chmodSync(target, statSync(target).mode | 0o755);
}

const cliPath = path.join(root, "dist", "cli.js");
ensureExecutable(cliPath);

/**
 * dist/native/<triple>/wand-render 同样要有可执行位。
 *
 * npm pack/unpack、CI artifact 下载、git checkout 都会丢可执行位（legacy 的
 * node-pty spawn-helper 就是栽在这），而 `src/render-binary.ts` 的
 * `isExecutableFile()` 只认 X_OK —— 丢了就会静默回落到 legacy / 找不到引擎。
 */
const nativeRoot = path.join(root, "dist", "native");
if (existsSync(nativeRoot)) {
  for (const triple of readdirSync(nativeRoot)) {
    const binary = path.join(nativeRoot, triple, "wand-render");
    try {
      ensureExecutable(binary);
    } catch (error) {
      // 权限修不上不该让整个 build 失败，但必须留痕。
      console.error(
        `[wand] warning: cannot make ${binary} executable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
