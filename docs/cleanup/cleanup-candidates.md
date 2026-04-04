# 清理候选审计

本文件记录这次仓库清理时的保守审计结果。原则是：

- 先找证据，再决定是否删除
- 运行时文件、发布文件、安装文件、说明文件默认不删
- 只有“低风险 + 无引用 + 不参与人工流程”的文件，才考虑直接删除

## 1. 审计范围

本次重点核对了：

- `package.json` scripts
- `README.md`
- `CLAUDE.md`
- `RELEASE_CHECKLIST.md`
- `install.sh`
- `publish.sh`
- `docs/` 现有内容
- 核心源码 import graph

## 2. 结论总览

| 路径 | 结论 | 风险 | 证据 |
|------|------|------|------|
| `install.sh` | 保留 | 高 | README 一键安装命令直接引用 |
| `publish.sh` | 保留 | 中 | 虽未被 `package.json` 调用，但属于手工发布入口 |
| `RELEASE_CHECKLIST.md` | 保留 | 中 | `CLAUDE.md` 明确引用，且属于人工 QA / 发布流程 |
| `UX_RESEARCH_REPORT.md` | 可删除 | 低 | 未在源码、README、CLAUDE.md、docs 中发现引用，内容是一次性研究报告 |
| `docs/architecture-analysis.md` | 重写保留 | 低 | 属于本次文档体系核心入口，不应删除 |
| `dist/` | 暂不处理 | 中 | 当前工作区存在构建产物，但本任务不应在未核对版本控制策略下直接删除 |

## 3. 各文件详细说明

### 3.1 `install.sh`

**结论：保留**

原因：

- README 中的一键安装命令直接使用：

```bash
bash <(curl -Ls https://raw.githubusercontent.com/co0ontty/wand/master/install.sh)
```

这意味着它不是“没人用的脚本”，而是面向最终用户的安装入口之一。

### 3.2 `publish.sh`

**结论：保留**

原因：

- 虽然 `package.json` 没有直接调用它
- 但脚本承担了“从 git tag 派生版本号 -> build -> npm publish”的完整手工发布链
- 属于 release / operations 资产，而不是运行时代码

后续如果要精简发布链，应该先统一发布策略，再考虑是否合并或下线该脚本。

### 3.3 `RELEASE_CHECKLIST.md`

**结论：保留**

原因：

- `CLAUDE.md` 里明确要求“Manual browser QA / release verification: Follow RELEASE_CHECKLIST.md”
- 文件内容覆盖浏览器登录、终端、chat、恢复、草稿、WebSocket、Git、性能等人工检查项
- 当前仓库没有自动化测试体系，这份检查单更重要

### 3.4 `UX_RESEARCH_REPORT.md`

**结论：本次已删除**

证据：

- 未在源码 import / readFile 路径中使用
- 未在 `README.md` 中引用
- 未在 `CLAUDE.md` 中引用
- 未在当前 `docs/` 文档体系中作为索引或依赖文档使用
- 内容是一次性 UX 调研与建议，不是当前运行逻辑说明，也不是安装/发布/构建流程的一部分

删除理由：

- 与本次新增的系统性运行文档相比，它属于孤立的历史研究材料
- 保留在仓库根目录会增加噪音

## 4. 未执行删除但值得后续继续审查的项

### 4.1 `publish.sh` 与 `prepublishOnly`
两者在“读取 tag、同步版本、执行 build”上存在重叠，后续可以评估是否合并发布流程。

### 4.2 `dist/`
如果团队希望仓库更干净，应结合 `.gitignore` 与发布方式确认：

- `dist/` 是否应纳入版本控制
- 本地构建产物是否应总是清理

由于这属于工作流决策，本次不直接处理。

## 5. 本次清理动作

- 删除：`UX_RESEARCH_REPORT.md`
- 保留：`install.sh`, `publish.sh`, `RELEASE_CHECKLIST.md`, `dist/`

## 6. 后续建议

如果还要继续做“仓库整洁化”，建议按下面顺序推进：

1. 先统一发布流程（`publish.sh` vs `prepublishOnly`）
2. 再确认 `dist/` 的版本控制策略
3. 最后处理零散历史文档、一次性报告与临时产物

这样不会误删仍在人工流程里承担作用的文件。