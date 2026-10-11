declare global {
  var __wandBrowserRuntime: {
    configPath: string;
    aiTeamsChunkSrc: string;
    plushAvatarChunkSrc: string;
  } | undefined;
}

// Literal fallbacks keep standalone component harnesses and legacy builds usable.
export const browserAssetRuntime = globalThis.__wandBrowserRuntime ?? {
  configPath: "${wandConfigPath}",
  aiTeamsChunkSrc: "${aiTeamsChunkSrc}",
  plushAvatarChunkSrc: "${plushAvatarChunkSrc}",
};
