// The classic bootstrap installs instance values before ESM dependencies execute.
// Feature modules contain no config path or mutable, server-injected source.
const runtime = {
  configPath: "${wandConfigPath}",
  aiTeamsChunkSrc: "${aiTeamsChunkSrc}",
  plushAvatarChunkSrc: "${plushAvatarChunkSrc}",
};
(globalThis as typeof globalThis & { __wandBrowserRuntime?: typeof runtime }).__wandBrowserRuntime = runtime;
const moduleSrc = "${browserModuleSrc}";
// The lookup belongs to this document/build, not the server's latest graph.
// Optional module URLs never leak into the cold runtime's content fingerprint.
const optionalModules = "${browserModuleImports}" as unknown as Record<string, string>;
const attempts = new Map<string, number>();
(globalThis as typeof globalThis & { __wandImportBrowserModule?: (id: string) => Promise<unknown> }).__wandImportBrowserModule = id => {
  const file = Object.prototype.hasOwnProperty.call(optionalModules, id) ? optionalModules[id] : undefined;
  if (!file) return Promise.reject(new Error("Unknown optional browser module"));
  const url = new URL(`/assets/${file}`, window.location.href);
  const attempt = attempts.get(id) ?? 0;
  if (attempt) url.searchParams.set("wandModuleRetry", String(attempt));
  return import(url.href).catch(error => { attempts.set(id, attempt + 1); throw error; });
};
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
