# Web bundle 构建、缓存与体积核对

## 构建入口

使用 `.nvmrc` 指定的 Node：

```bash
npm run check
WAND_BUILD_CHANNEL=beta npm run build
```

验证不调用真实付费模型。

## 模块寻址

- `scripts/bundle-browser.js` 保留一个 eager runtime；React 和状态 owner 不复制到功能包。
- `scripts/address-browser-modules.js` 给模块的**静态依赖闭包**生成指纹。静态循环依赖共享一个强连通分量指纹；导入依赖改变时，引用者地址也改变。
- 动态导入使用稳定的逻辑 ID，经当前文档 bootstrap 中的 lookup 查找实际 URL。因此按需页面正文改变，不再仅因全图目录变化而使无关模块 URL 一起失效。
- 逻辑 ID 根据 entrypoint 或 shared chunk 的输入集合生成；它不是权限、凭据或功能 API。
- 页面自己的 `__wandImportBrowserModule` 保留本页 lookup 和失败重试次数；只有显式再次加载失败模块才使用新 retry URL，不把服务端最新映射灌入旧页面。
- `module-manifest.json` 包含 `buildId`、`imports`、`dependencies`、`integrity` 和原有 entry/eager/files/features。指纹目录下的资源仍只返回该 URL 对应的字节，不能用新资源冒充缺失的旧资源。

`src/web-ui/scripts.ts` 先读取并校验完整图，再替换当前快照。文件缺失或 SHA 不符时保留上一完整图。运行进程保留最近两份磁盘快照及内嵌 fallback，兼容旧的全图目录格式；更新期间目录移除不破坏已经保留的 lazy bytes。这不是跨服务重启永久保存所有历史网页：已超出保留范围的 URL 返回 no-store 404，页面应显式重试/刷新，绝不缓存错误版本。

## 体积优化边界

- 设置页的名称/值信息直接用 Ant Descriptions、Spin、Empty，不为简单展示拉入 Table/filter/tree，也不维护自制表格兼容层。
- 文件预览轻模型在 `file-preview/model.ts`，Marked 映射在 `markdown-model.ts`。冷启动可见的会话预览通过共享 `deferredComponent` 加载 canonical Markdown renderer，加载时保持文字可读，失败提供原共享重试；不新增第二套解析或发送状态 owner。
- ESM CSS 字符串池是模块顶层私有变量，不用 IIFE 包住 imports/exports。静态 CSS 压缩只针对明确 allowlist，插值和不安全转义保持原样；动态主题、media 和 reduced-motion 规则保留。
- 3D 和终端能力不因体积门禁自动降级。

## 计量口径

`check-bundle-budget.js` 按 gzip 降序打印产物，并保留现有硬上限、基线棘轮与 conservative firstLoad 门禁。仅把模块移到 lazy 不等于减少 allModules。

报告明确区分：

| 项目 | 计入内容 |
| --- | --- |
| firstLoad（兼容门禁） | HTML + bootstrap + CSS + theme + eager ESM + 全部 terminal/QR vendor 预留；不是实际 HAR |
| shell | 不含任何可选功能和可见 3D 头像的基础资产 |
| visibleAvatar | shell + 可见头像触发的独立 Three runtime |
| conversation / conversationWithAvatar | shell + chat renderer 的静态依赖闭包，可再加头像 |
| terminal / qrCode | shell + 对应 vendor；不冒充包含工作区/设置视图的完整场景 |
| allWebAssets | 所有计量资产去重合计，含 lazy ESM、团队、3D 和 vendor |

这些是静态场景估算；实际首屏请求还取决于路由、会话、可见性和浏览器缓存。真实传输验收需要对应版本的已安装服务，不能用模拟或静态预算替代。

## 可追溯证据

生成资产时校验模块 SHA 与 esbuild 图 buildId，并将 Web 全部资产/graph 的 SHA 绑定到 `EMBEDDED_WEB_ASSETS.buildIdentity`。不依赖后续可能被覆盖的 latest graph 推断旧构建。

```text
output/web-ui-library-migration/builds/<buildIdentity.id>/
  build-manifest.json
  bundle-graphs/*.json
  bundle-budget.json
```

构建 ID 同时区分 Node/zlib 测量环境；相同 ID 复用同一目录。`output/web-ui-library-migration/bundle-budget.json` 和 `bundle-graphs/` 仍作为兼容的 latest 入口。预算报告带有构建 ID、SHA、场景定义及完整失败项；每个有身份的报告也写入对应归档，避免不同轮次的产物与 graph 混用。

`dist/web-ui/embedded-assets.js` 与 content 中的资产是磁盘冗余，不是浏览器重复下载；内嵌资产承担包替换期间的 fallback，不能为了缩小 npm 清单直接删除。
