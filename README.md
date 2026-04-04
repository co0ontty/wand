# wand

通过浏览器访问本地终端，支持 Claude 等命令行工具。

## 功能

- Web 终端 / Chat 模式双视图
- 会话持久化与恢复
- Claude Code 集成
- 文件浏览器
- HTTPS 安全连接（可选，配置 `https: true` 启用）

## 一键安装

```bash
bash <(curl -Ls https://raw.githubusercontent.com/co0ontty/wand/master/install.sh)
```

## 手动安装

```bash
npm install -g @co0ontty/wand
wand init
wand web
```

配置文件：`~/.wand/config.json`

## 开发

```bash
npm install
npm run build
npm run dev
```

## License

MIT