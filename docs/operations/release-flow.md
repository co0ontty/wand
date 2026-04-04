# 发布、安装与运行流程

这一页专门整理 README、`package.json`、`install.sh`、`publish.sh`、`RELEASE_CHECKLIST.md` 之间的关系，帮助理解项目的开发/交付链路，也为后续清理文件提供上下文。

## 1. 日常开发入口

根据 `package.json`，当前日常开发相关脚本是：

```bash
npm install
npm run check
npm run build
npm run dev
```

### `npm run check`
执行：

```bash
tsc --noEmit -p tsconfig.json
```

用于纯类型检查。

### `npm run build`
执行：

```bash
tsc -p tsconfig.json && npm run build:copy-content
```

而 `build:copy-content` 是：

```bash
cp -r src/web-ui/content dist/web-ui/
```

这一步很关键，因为浏览器端资源不是独立 bundler 产物，打包后运行仍依赖 `dist/web-ui/content`。

### `npm run dev`
执行：

```bash
tsx src/cli.ts web
```

这说明开发模式不是跑一个独立前端 dev server，而是直接用 tsx 启动服务端入口。

## 2. README 描述的用户安装流

`README.md` 给出了两条安装路径：

### 2.1 一键安装

```bash
bash <(curl -Ls https://raw.githubusercontent.com/co0ontty/wand/master/install.sh)
```

它直接依赖仓库根目录的 `install.sh`。

### 2.2 手动安装

```bash
npm install -g @co0ontty/wand
wand init
wand web
```

这条路径说明最终交付物是 npm 包 `@co0ontty/wand`，用户运行的是打包后的 `dist/cli.js` 对应的 `wand` 命令。

## 3. `install.sh` 的定位

`install.sh` 不是构建脚本，而是**用户环境安装脚本**。它会：

1. 检查系统里是否已有 Node.js
2. 若版本不足，尝试通过 NodeSource 安装 Node 22
3. 执行 `npm install -g @co0ontty/wand`
4. 执行 `wand init`
5. 提示用户运行 `wand web`

因此它虽然没有被 `package.json` 调用，但被 README 的安装入口直接引用，不能视为无用文件。

## 4. `publish.sh` 的定位

`publish.sh` 是**手工发布脚本**，主要做：

1. 从最新 git tag 读取版本号
2. 更新 `package.json` 的 `version`
3. 执行 `npm run build`
4. 执行 `npm publish --access public`

这说明当前仓库的发布流程至少部分依赖：

- git tag
- 手工运行 shell 脚本
- npm publish

它不是运行时依赖，但属于发布运维资产，也不应轻易删除。

## 5. `prepublishOnly` 与 `publish.sh` 的关系

`package.json` 中还有一条脚本：

```json
"prepublishOnly": "TAG=$(git tag --sort=-v:refname --list 'v*' | head -1) && VER=${TAG#v} && npm version $VER --no-git-tag-version --allow-same-version && npm run build"
```

它和 `publish.sh` 有明显重叠：

- 都会从最新 tag 推导版本
- 都会更新 package version
- 都会执行 build

区别在于：

- `prepublishOnly` 会在 npm publish 流程前自动执行
- `publish.sh` 是显式的发布入口包装脚本

因此两者不是完全重复，但确实存在职责重叠，后续如果要精简发布链，可以优先从这里审查。

## 6. `RELEASE_CHECKLIST.md` 的定位

这个文件是**人工发布 / 浏览器 QA 检查清单**。内容覆盖：

- 构建检查
- 浏览器登录与主界面检查
- Chat / 终端视图检查
- 输入框与快捷键检查
- 会话管理检查
- 草稿持久化检查
- WebSocket 断线重连检查
- Git 检查
- 性能检查

这说明当前项目虽然没有自动化测试，但存在一套明确的人工验收流程。

因此：

- 不能因为“它没被代码 import”就把它当垃圾文件
- 文档体系应该把它归入 operations，而不是 architecture

## 7. `dist/` 的角色

仓库当前已经存在 `dist/`，说明本地工作区里保留了构建产物。运行时上：

- `wand` 命令最终指向 `dist/cli.js`
- `README` 的手动安装流依赖打包后产物

但从仓库清理角度看，`dist/` 是否应长期保留在版本控制里，需要结合 `.gitignore` 与发布策略再判断；当前任务里不应直接删除现有 `dist/`，因为它可能包含用户当前未提交修改所依赖的构建结果。

## 8. 当前开发/验证的现实情况

这个仓库当前没有：

- 自动化测试脚本
- 单个测试运行命令
- lint 脚本
- format 脚本

所以当前最接近“官方验证路径”的方式是：

```bash
npm run check
npm run build
```

以及在需要时手动跑：

```bash
node dist/cli.js init
node dist/cli.js web
```

而浏览器侧验收依赖 `RELEASE_CHECKLIST.md`。

## 9. 对“无用文件清理”的影响

从发布/安装链路看，以下文件都不能因为“未被 import”就直接删除：

- `install.sh`：被 README 一键安装引用
- `publish.sh`：手工发布入口
- `RELEASE_CHECKLIST.md`：人工验收流程说明
- `README.md`：用户安装说明入口

相反，这些文件应该被视为 operations 资产。

## 10. 一句话总结

当前仓库的交付模型是：

- **开发时**：`tsx + TypeScript + 直接跑服务`
- **打包时**：`tsc + 复制 web-ui 静态资源`
- **安装时**：`npm install -g` 或 `install.sh`
- **发布时**：`git tag + prepublishOnly + publish.sh + npm publish`
- **验收时**：`RELEASE_CHECKLIST.md` 人工检查

因此只看源码 import graph 是不够的；很多看似“没被引用”的文件，其实属于仓库的运维/发布工作流。
