import { registerHooks } from "node:module";

// Keep the executable CLI's built-ins available, but make Wand's public SDK
// entry impossible to load. This reproduces a broken/missing SDK without
// editing node_modules or touching a running service.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent"
      || /\/pi-coding-agent\/dist\/index\.js(?:[?#]|$)/.test(specifier)) {
      const key = Symbol.for("wand.sdk.importAttempts");
      globalThis[key] = (globalThis[key] ?? 0) + 1;
      if (process.env.WAND_PI_SDK_PROBE_ALLOW !== "1") throw new Error("WAND_PI_SDK_IMPORT_BLOCKED");
    }
    return nextResolve(specifier, context);
  },
});
