// 自动生成标题是后台完成的，创建响应里只有描述首行占位；这里短轮询几次，拿到模型标题就停。
export const GENERATED_TITLE_POLL_DELAYS_MS: readonly number[] = [1_200, 2_000, 3_000, 5_000, 8_000];

export interface GeneratedTitlePollerOptions {
  /** 读取单条任务；请求失败按「这一轮还没生成」处理。 */
  readonly getTask: (taskId: string) => Promise<{ title: string } | null>;
  /** 每轮轮询后刷新看板列表。 */
  readonly reload: () => Promise<void>;
  /** 覆盖等待实现（测试注入假时钟）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 覆盖延迟序列。 */
  readonly delays?: readonly number[];
}

export interface GeneratedTitlePoller {
  /** 开始轮询。重复调用会作废上一轮，不会叠加两个循环。 */
  start(taskId: string, placeholder: string): Promise<void>;
  /** 作废当前轮询：不再等待、不再请求，在途的 start 会静默结束。 */
  cancel(): void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function createGeneratedTitlePoller(options: GeneratedTitlePollerOptions): GeneratedTitlePoller {
  const sleep = options.sleep ?? wait;
  const delays = options.delays ?? GENERATED_TITLE_POLL_DELAYS_MS;
  // 每轮轮询绑定一个世代号：cancel 或下一次 start 都会推进它，旧循环自行退出。
  let generation = 0;

  return {
    cancel(): void {
      generation += 1;
    },
    async start(taskId: string, placeholder: string): Promise<void> {
      const mine = (generation += 1);
      for (const delay of delays) {
        if (mine !== generation) return;
        await sleep(delay);
        if (mine !== generation) return;
        await options.reload();
        if (mine !== generation) return;
        const task = await options.getTask(taskId).catch(() => null);
        // 标题还是占位值说明后台还没总结完（或总结失败），继续等到下一次轮询。
        if (task && task.title && task.title !== placeholder) return;
      }
    },
  };
}
