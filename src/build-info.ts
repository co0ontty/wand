/**
 * 构建信息共享类型：`dist/build-info.json` 由 scripts/stamp-build-info.js 在打包时写入，
 * server 组合根、设置路由、更新路由都消费同一份数据，避免各自再定义一遍形状。
 */

/** 构建信息中除版本号外的字段。 */
export interface BuildInfo {
  commit: string | null;
  builtAt: string | null;
  channel: string | null;
}

/** 服务端进程持有的完整构建信息。 */
export interface WandBuildInfo extends BuildInfo {
  version: string | null;
}

/** API 展示用的 build 载荷：统一补 7 位短 commit。 */
export function buildInfoPayload(buildInfo: BuildInfo): BuildInfo & { shortCommit: string | null } {
  return {
    commit: buildInfo.commit,
    shortCommit: buildInfo.commit ? buildInfo.commit.slice(0, 7) : null,
    builtAt: buildInfo.builtAt,
    channel: buildInfo.channel,
  };
}
