import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, DatePicker } from "antd";
import { Bubble, Sender } from "@ant-design/x";
import { WandUiProvider, wandTheme } from "../src/web-ui/react/theme.js";
import { installSharedLibraryBridge } from "../src/web-ui/react/library-bridge.js";
import { WandButton, WandInput, WandSelect, filterSelectOptions, showWandToast } from "../src/web-ui/react/ui/index.js";
import { createAiTeamsHostPlugin } from "../scripts/ai-teams-chunk.js";

test("foundation uses exact approved library versions without an Appica runtime", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies.antd, "6.6.5");
  assert.equal(pkg.devDependencies["@ant-design/x"], "2.9.0");
  assert.equal(lock.packages["node_modules/antd"].version, "6.6.5");
  assert.equal(lock.packages["node_modules/@ant-design/x"].version, "2.9.0");
  assert.equal(lock.packages["node_modules/@appica/ui-react"], undefined);
});

test("independent IIFEs resolve the same controls and provider rather than duplicate libraries", async () => {
  installSharedLibraryBridge();
  const result = await build({
    stdin: { contents: `import { Button, DatePicker } from "antd";
      import { Bubble, Sender } from "@ant-design/x";
      import { WandUiProvider, WandButton, usePortalContainer } from "./src/web-ui/react/ui";
      import { readMotionTokenMs } from "./src/web-ui/react/ui/motion-tokens";
      globalThis.result = { Button, DatePicker, Bubble, Sender, WandUiProvider, WandButton, usePortalContainer, readMotionTokenMs };`,
      resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, platform: "browser", format: "iife", write: false, metafile: true,
    plugins: [createAiTeamsHostPlugin()],
  });
  const context: Record<string, any> = {
    __wandSharedLibrary: globalThis.__wandSharedLibrary,
    __wandAiTeamsHost: (key: string) => key === "react" ? React : jsx,
  };
  runInNewContext(result.outputFiles[0].text, context);
  assert.equal(context.result.Button, Button);
  assert.equal(context.result.DatePicker, DatePicker);
  assert.equal(context.result.Bubble, Bubble);
  assert.equal(context.result.Sender, Sender);
  assert.equal(context.result.WandUiProvider, WandUiProvider);
  assert.equal(context.result.WandButton, WandButton);
  assert.equal(typeof context.result.usePortalContainer, "function");
  assert.equal(typeof context.result.readMotionTokenMs, "function");
  assert.equal(Object.keys(result.metafile!.inputs).some(path => path.includes("node_modules/")), false);
});

test("public controls keep native form attributes and filter stable option identities", () => {
  const html = renderToStaticMarkup(React.createElement(WandUiProvider, null,
    React.createElement(WandButton, { kind: "primary", type: "submit", disabled: true, "aria-label": "Save" }, "Save"),
    React.createElement(WandInput, { inputSize: "sm", "aria-label": "Name", defaultValue: "draft", startSlot: "icon" }),
    React.createElement(WandSelect, { ariaLabel: "Model", value: "", options: [{ value: "", label: "Default" }, { value: "a", label: "Alpha" }] }),
  ));
  assert.match(html, /type="submit"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-label="Name"/);
  assert.match(html, /value="draft"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /Default/);
  assert.equal(wandTheme.token?.colorPrimary, "#b8562f");
  const options = [{ value: "", label: "Default" }, { value: "openai/gpt-5.4", label: "GPT-5.4", group: "OpenAI" }, { value: "claude", label: "Claude", disabled: true }];
  assert.deepEqual(filterSelectOptions(options, "gpt 5.4"), [options[1]]);
  assert.deepEqual(filterSelectOptions(options, "OpenAI 5.4"), [options[1]]);
  assert.deepEqual(filterSelectOptions(options, " default "), [options[0]]);
  assert.notEqual(filterSelectOptions(options, ""), options);
});

test("plain module toast calls have stable independent dismissal handles before mounting", () => {
  const first = showWandToast("first", { duration: 0 });
  const second = showWandToast("second", { tone: "warning" });
  assert.notEqual(first.id, second.id);
  first.dismiss(); first.dismiss(); second.dismiss();
});
