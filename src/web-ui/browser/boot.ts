// The classic bootstrap installs instance values before ESM dependencies execute.
// Feature modules contain no config path or mutable, server-injected source.
const runtime = {
  configPath: "${wandConfigPath}",
  aiTeamsChunkSrc: "${aiTeamsChunkSrc}",
  plushAvatarChunkSrc: "${plushAvatarChunkSrc}",
};
(globalThis as typeof globalThis & { __wandBrowserRuntime?: typeof runtime }).__wandBrowserRuntime = runtime;
const moduleSrc = "${browserModuleSrc}";
void import(moduleSrc).catch(() => {
  const root = document.getElementById("app");
  if (!root) return;
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = "界面资源加载失败，可能是网络中断或服务刚完成更新。";
  const retry = document.createElement("button");
  retry.textContent = "重新加载";
  retry.onclick = () => window.location.reload();
  root.replaceChildren(message, retry);
});
