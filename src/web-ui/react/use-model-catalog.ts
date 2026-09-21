import { useEffect, useState } from "react";

import { cachedWandModelCatalog, loadWandModelCatalog, type WandModelCatalog } from "./model-catalog";

/**
 * 模型目录：冷缓存时拉一次 `GET /api/models`，热缓存直接同步渲染。
 *
 * `enabled` 用于把请求挂在对话框打开之后——React 外壳（含 overlay host）在登录前就已挂载，
 * 过早请求会拿到 401；失败不写缓存，所以下一次打开对话框会重试。
 */
export function useWandModelCatalog(enabled = true): WandModelCatalog | null {
  const [catalog, setCatalog] = useState<WandModelCatalog | null>(() => cachedWandModelCatalog());
  useEffect(() => {
    if (!enabled || cachedWandModelCatalog()) return;
    const abort = new AbortController();
    void loadWandModelCatalog(abort.signal)
      .then((loaded) => { if (!abort.signal.aborted) setCatalog(loaded); })
      .catch(() => undefined);
    return () => abort.abort();
  }, [enabled]);
  return catalog;
}
