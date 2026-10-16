/** Static transfer scenarios, not a claim about a particular user's HAR.
 * Keep the historical conservative gate (all vendors) separately; count
 * visible avatars and feature static dependencies explicitly and deduplicate. */
export function measureBrowserLoadScenarios(manifest, measurements) {
  const assets = new Map(measurements.map(row => [row.name.replace(/ \((?:eager|lazy)\)$/, ""), row]));
  const core = ["HTML (repeat)", "app.js (cached)", "app.css (cached)", "theme.js (cached)", ...manifest.eager];
  function closure(entries) {
    const seen = new Set();
    function visit(file) {
      if (seen.has(file)) return;
      seen.add(file);
      for (const dependency of manifest.dependencies?.[file] ?? []) visit(dependency);
    }
    for (const entry of entries) visit(entry);
    return [...seen];
  }
  function scenario(files, assumption) {
    const unique = [...new Set(files)].filter(file => assets.has(file));
    return { gzip: unique.reduce((sum, file) => sum + assets.get(file).gzip, 0),
      raw: unique.reduce((sum, file) => sum + assets.get(file).raw, 0), files: unique, assumption };
  }
  const avatar = "plush-avatar.js";
  const chat = manifest.features?.["src/web-ui/browser/chat-render.ts"];
  const scenarios = {
    shell: scenario(core, "HTML/bootstrap/theme/CSS and eager modules only; no optional feature or visible 3D avatar"),
    visibleAvatar: scenario([...core, avatar], "shell plus a visible 3D identity, which starts the standalone renderer download"),
    terminal: scenario([...core, "/vendor/xterm/xterm.bundle.js", "/vendor/xterm/xterm.css"], "shell plus terminal vendor; excludes optional workspace views"),
    qrCode: scenario([...core, "/vendor/qrcode/qrcode.bundle.js"], "shell plus QR vendor; excludes the settings view"),
  };
  if (chat) {
    scenarios.conversation = scenario([...core, ...closure([chat])], "shell plus chat renderer and its static dependencies; other dynamic edges load on use");
    scenarios.conversationWithAvatar = scenario([...core, ...closure([chat]), avatar], "conversation plus a visible 3D identity");
  }
  scenarios.allWebAssets = scenario([...assets.keys()], "every budgeted asset exactly once, including all optional ESM, teams, 3D and vendor assets");
  return { kind: "static-scenarios-not-observed-network", staticDependenciesComplete: !!manifest.dependencies, scenarios };
}
