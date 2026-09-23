# Render 协议（已迁出本仓库）

Render 协议 v1 的权威契约现在由 **`co0ontty/wand-render`** 拥有，在本仓库以子模块形式可见：

```text
render/docs/render-protocol.md
```

为什么迁走：协议是 Render 的接口，而 Render 已拆成独立仓库、独立发布、独立版本号。
契约放在接口拥有方，避免「主仓库的副本」与「真正实现」两处漂移。
机器可读的真源是 `render/crates/wand-render-protocol/src/lib.rs`（Rust 类型与帧编解码），
TS 镜像在本仓库 `src/render-protocol.ts`。

未初始化子模块时先执行：

```bash
git submodule update --init render render-bin
```

## 本仓库需要知道的几件事

- **Server / Render 职责边界**：Server（本仓库，Node）拥有 HTTP/WS、鉴权、SQLite、业务与聊天投影；
  Render（`render/` 子模块，Rust 常驻进程）拥有 PTY、输出 journal、VT 屏幕模型与退出状态。
  Server 因 npm 升级重启时 Render 与用户 shell 不停止。
- **产物**：`render-bin/` 子模块 pin 住各平台二进制与 `manifest.json`；`npm run build` 校验 sha256 后
  把它们 stage 到 `dist/native/<triple>/`。产物由 CI 从 `render/` 构建，不在本仓库编译。
- **引擎开关**：`render.engine = auto | rust | legacy`（环境变量 `WAND_RENDER_ENGINE` 优先）。
  协议版本不匹配时拒绝启动，不降级运行。
- **升级与回滚**：见 [`render-upgrade-path.md`](render-upgrade-path.md)。
