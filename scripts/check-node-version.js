import { compareNodeVersions, nodeBaseline } from "./node-version.js";

const current = process.versions.node;
if (compareNodeVersions(current, nodeBaseline) < 0) {
  console.error(`[wand] Node >= ${nodeBaseline} is required; got v${current}. Run \`nvm use\`.`);
  process.exit(1);
}
if (current !== nodeBaseline) {
  console.warn(
    `[wand] Node v${current} is newer than the baseline v${nodeBaseline} in .nvmrc; ` +
      "bundle-budget bytes are measured on the baseline and may drift here.",
  );
}
