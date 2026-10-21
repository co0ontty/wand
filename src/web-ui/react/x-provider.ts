import * as React from "react";
import * as xProviderModule from "@ant-design/x/es/x-provider";
import type { XProviderProps } from "@ant-design/x/es/x-provider";

/**
 * @ant-design/x 只在按需分块里使用；首屏主题只借用它的 Provider，
 * 因此这里走窄路径，避免把包桶（连带 Sender / FileCard 整套实现）拉进首屏 runtime。
 *
 * 窄路径的默认导出在两种载入方式下形态不同：ESM 打包直接是组件，
 * tsx/CJS 载入会多包一层模块对象。这里统一取到真正的组件，
 * 保证浏览器与测试环境拿到同一个实现。
 */
function resolveXProvider(): React.ComponentType<XProviderProps> {
  const exported = (xProviderModule as { default?: unknown }).default;
  const provider = typeof exported === "function" ? exported : (exported as { default?: unknown } | undefined)?.default;
  if (typeof provider !== "function") throw new Error("@ant-design/x/es/x-provider 未导出 XProvider 组件");
  return provider as React.ComponentType<XProviderProps>;
}

export const XProvider = resolveXProvider();
export type { XProviderProps };
