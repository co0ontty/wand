# 员工资料整页设计预览

这是等待视觉确认的独立交互预览，不是生产页面入口。复用 Wand 的公共控件、主题与真实 3D 渲染器；所有资料、头像和候选修改只保存在当前页面内存中，不连接员工 API、不派发模型任务。两个固定猫头采用精确源映射，其他像素猫和上传头像保留。

```sh
node scripts/design-previews/employee-profile/serve.mjs
```

只监听 `127.0.0.1:8794`。构建输出还包含可离线打开的 `Wand-employee-profile-preview.html`，其中 CSP 禁止网络连接。

```sh
node node_modules/typescript/bin/tsc --noEmit -p scripts/design-previews/employee-profile/tsconfig.json
node scripts/design-previews/employee-profile/verify.mjs
node scripts/design-previews/employee-profile/verify-extra.mjs
```

验证使用本机 Chrome 和隔离浏览器配置；保存/取消、候选排序、搜索空态、键盘、长名字、320/390px、五主题、上传与静态降级均有实际验证。HTML 与证据是构建产物，不提交。预览使用少量明确标注的样例资料；生产候选编辑仍应复用已有业务校验与真实目录，不将预览样例当成工具能力目录。整页尚未接入已安装服务，等待用户确认设计。
