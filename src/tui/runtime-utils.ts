/** TUI 运行时探针与小工具，供本地 TUI / attach TUI / snapshot 共享。 */

import { isServiceInstalled } from "./commands.js";

/** 读取进程 RSS；失败时返回 0，避免探针异常影响渲染。 */
export function safeRss(): number {
  try {
    return process.memoryUsage().rss;
  } catch {
    return 0;
  }
}

/** 查询服务安装状态；失败时返回 false。 */
export function safeServiceInstalled(): boolean {
  try {
    return isServiceInstalled();
  } catch {
    return false;
  }
}

/** 把同步阻塞操作放到下一 microtask，给 TUI 留出一帧把 toast 画出来。 */
export function runOffMicrotask<T>(fn: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(fn()); } catch (err) { reject(err); }
    });
  });
}
