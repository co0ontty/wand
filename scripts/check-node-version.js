import { readFileSync } from "node:fs";

const required = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
if (process.versions.node !== required) {
  console.error(`[wand] Node ${required} is required for reproducible builds; got ${process.version}. Run \`nvm use\`.`);
  process.exit(1);
}
