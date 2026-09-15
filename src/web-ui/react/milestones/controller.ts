// 里程碑列表的共享外部 store：任务看板与「新建任务」对话框共用一份缓存，
// 任何一处新增后另一处的下拉立刻能看到，不会再各自拉一次接口。

import { httpMilestonesRepository, type MilestoneOption, type MilestonesRepository } from "./repository";
import { failureMessage } from "../errors";

export interface MilestonesSnapshot {
  items: MilestoneOption[];
  /** 首次加载中；后续刷新不阻塞下拉。 */
  loading: boolean;
  /** 是否已经成功拉过一次列表。 */
  loaded: boolean;
  error: string;
  revision: number;
}

type Listener = () => void;

let snapshot: MilestonesSnapshot = { items: [], loading: false, loaded: false, error: "", revision: 0 };
let repository: MilestonesRepository = httpMilestonesRepository;
let inflight: Promise<void> | null = null;
const listeners = new Set<Listener>();

function publish(patch: Partial<Omit<MilestonesSnapshot, "revision">>): void {
  snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

export const milestonesStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): MilestonesSnapshot {
    return snapshot;
  },
  /** 拉取列表；已加载过且未要求刷新时直接复用缓存（多个面板同时打开只打一次接口）。 */
  load(force = false): Promise<void> {
    if (inflight) return inflight;
    if (snapshot.loaded && !force) return Promise.resolve();
    publish({ loading: true });
    inflight = repository.list()
      .then((items) => publish({ items, loaded: true, loading: false, error: "" }))
      .catch((error) => publish({ loading: false, error: failureMessage(error, "无法加载里程碑。") }))
      .finally(() => { inflight = null; });
    return inflight;
  },
  /** 新建里程碑并把它插到列表最前面（服务端按创建时间倒序返回）。 */
  create(name: string): Promise<MilestoneOption> {
    const trimmed = name.trim();
    if (!trimmed) return Promise.reject(new Error("请填写里程碑名称。"));
    return repository.create({ name: trimmed }).then((created) => {
      publish({ items: [created, ...snapshot.items], loaded: true, error: "" });
      return created;
    });
  },
};

/** 测试用：注入假 repository 并清空缓存。 */
export function configureMilestonesRepository(next: MilestonesRepository): () => void {
  const previous = repository;
  repository = next;
  snapshot = { items: [], loading: false, loaded: false, error: "", revision: snapshot.revision + 1 };
  inflight = null;
  for (const listener of listeners) listener();
  return () => {
    if (repository === next) repository = previous;
  };
}

/** 按 id 取里程碑名；看板卡片只拿到 milestoneId 时用它显示名字。 */
export function milestoneNameOf(items: readonly MilestoneOption[], id: string | null | undefined): string {
  if (!id) return "";
  return items.find((item) => item.id === id)?.name ?? "";
}
