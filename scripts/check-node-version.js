import { compareNodeVersions, nodeBaseline, nodeMinimum } from "./node-version.js";

const current = process.versions.node;
if (compareNodeVersions(current, nodeMinimum) < 0) {
  console.error(`[wand] Node >= ${nodeMinimum} is required; got v${current}. Run \`nvm use\`.`);
  process.exit(1);
}
if (current !== nodeBaseline) {
  console.warn(
    `[wand] Node v${current} differs from the build baseline v${nodeBaseline} in .nvmrc; ` +
      "bundle-budget bytes are measured on the baseline and may drift here.",
  );
}
