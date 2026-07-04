/**
 * 语义化版本工具：单一真源，供 server / tui / path-repair / models 共用，
 * 避免各处各写一份比较/提取逻辑导致 debug.MMDDHHMM 后缀排序不一致。
 */

/** 从任意文本中提取 X.Y.Z[-prerelease][+build] 形式的版本号（带捕获组）。 */
export const SEMVER_PATTERN = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)/;

/** 提取文本中的第一个语义化版本号，没有则返回 null。 */
export function extractSemver(text: string): string | null {
  const match = text.match(SEMVER_PATTERN);
  return match ? match[1] : null;
}

/**
 * 比较两个语义化版本号，返回正数 = a > b，负数 = a < b，0 = 相等。
 * - 容忍前导 `v`（如 nvm/fnm 的 v18.0.0 目录名）。
 * - 主版本逐段数值比较；相等时按 semver 规则：无 prerelease > 有 prerelease。
 * - 两者都有 prerelease 时按 `.` 分段比较（数字段数值比、非数字段字典序），
 *   贴近标准 semver，避免 debug.MMDDHHMM 后缀因纯字典序而跨月/跨年排反。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverLike(a);
  const pb = parseSemverLike(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.mainParts[i] || 0) - (pb.mainParts[i] || 0);
    if (diff !== 0) return diff;
  }
  // Main version equal — apply semver prerelease rule: no prerelease > with prerelease.
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  return comparePrereleaseSegments(pa.pre, pb.pre);
}

/** 按 `.` 分段比较 prerelease 后缀：数字段数值比、非数字段字典序、段少者更小。 */
function comparePrereleaseSegments(preA: string, preB: string): number {
  const segA = preA.split(".");
  const segB = preB.split(".");
  const segLen = Math.max(segA.length, segB.length);
  for (let i = 0; i < segLen; i++) {
    const sa = segA[i];
    const sb = segB[i];
    if (sa === undefined) return -1; // 段少者更小
    if (sb === undefined) return 1;
    const na = Number(sa);
    const nb = Number(sb);
    const aIsNum = sa !== "" && !Number.isNaN(na);
    const bIsNum = sb !== "" && !Number.isNaN(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1; // 数字段 < 非数字段
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Android APK 安装序比较 —— 与 android/app/build.gradle 的 computeVersionCode 镜像一致，
 * 回答「这个包能否覆盖安装到那个包之上 / 该不该提示升级」。返回正数 = a 比 b 新。
 *
 * 与标准 semver（compareSemver）的关键差异：同主版本三段时，带 `-debug` 后缀的包
 * 【更新】而不是更旧 —— debug 包是 tag 之后的 master 构建（versionCode = base+1，
 * release 是 base+0），系统安装器只认 versionCode。若在这里沿用 semver 的
 * 「prerelease < release」规则，就会提示用户从 debug「升级」到同号 release，
 * 下载后被系统按降级拒装。
 *
 * - 三段数值比较优先；
 * - 同三段：带 -debug > 不带（镜像 versionCode base+1 > base+0）；
 * - 两个 debug：按后缀分段比较（debug.MMDDHHMM 时间戳数值比），versionCode 相同、
 *   系统允许互装，比较结果只用于「是否提示更新」。
 */
export function compareApkInstallOrder(a: string, b: string): number {
  const pa = parseSemverLike(a);
  const pb = parseSemverLike(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.mainParts[i] || 0) - (pb.mainParts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (pa.isDebug !== pb.isDebug) return pa.isDebug ? 1 : -1;
  if (pa.isDebug && pb.isDebug) return comparePrereleaseSegments(pa.pre, pb.pre);
  return 0;
}

function parseSemverLike(v: string): { mainParts: number[]; pre: string; isDebug: boolean } {
  const withoutBuild = v.trim().replace(/^v/, "").split("+")[0] ?? "";
  const [main, ...rest] = withoutBuild.split("-");
  const pre = rest.join("-");
  const mainParts = main.split(".").map((n) => Number(n) || 0);
  return { mainParts, pre, isDebug: pre.startsWith("debug") };
}
