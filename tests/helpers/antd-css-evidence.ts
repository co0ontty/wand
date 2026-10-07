import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Opt-in integration evidence: only selectors/counts and structural states, never page text. */
export function cssEvidenceCapture(lane: string) {
  const probes = resolve("output/web-ui-library-migration/integration/css-probes.json");
  const path = existsSync(probes) ? probes : resolve("output/web-ui-library-migration/integration/css-candidates.json");
  const enabled = process.env.WAND_CSS_EVIDENCE === "1" && existsSync(path);
  const selectors: string[] = enabled ? [...new Set(JSON.parse(readFileSync(path, "utf8")).map((rule: { selector: string }) => rule.selector))] as string[] : [];
  const destination = resolve(`output/web-ui-library-migration/integration/css-runtime/${lane}.json`);
  const states = new Map<string, { samples: number; maxHits: number[]; invalid: number[] }>();
  if (enabled && existsSync(destination)) {
    const previous = JSON.parse(readFileSync(destination, "utf8"));
    if (JSON.stringify(previous.selectors) === JSON.stringify(selectors)) {
      for (const [state, value] of Object.entries(previous.states)) states.set(state, value as { samples: number; maxHits: number[]; invalid: number[] });
    }
  }
  let last = 0;
  return async (send: (method: string, params: Record<string, unknown>) => Promise<any>): Promise<void> => {
    if (!enabled || Date.now() - last < 100) return;
    last = Date.now();
    const expression = `(()=>{const selectors=${JSON.stringify(selectors)};const invalid=[];const counts=selectors.map((s,i)=>{try{return document.querySelectorAll(s).length}catch{invalid.push(i);return -1}});return {state:JSON.stringify({width:innerWidth,native:document.documentElement.classList.contains('is-wand-app'),rollback:location.search.includes('reactUi=0'),reduced:matchMedia('(prefers-reduced-motion:reduce)').matches,modals:document.querySelectorAll('[role=dialog]').length,popups:document.querySelectorAll('.ant-dropdown,.ant-picker-dropdown,.ant-popover').length,hidden:document.querySelectorAll('[hidden],[inert],[aria-hidden=true]').length}),counts,invalid}})()`;
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails || !result.result?.value) return;
    const sample = result.result.value;
    const entry = states.get(sample.state) ?? { samples: 0, maxHits: selectors.map(() => 0), invalid: [] };
    entry.samples++;
    sample.counts.forEach((count: number, index: number) => { entry.maxHits[index] = Math.max(entry.maxHits[index], count); });
    entry.invalid = [...new Set([...entry.invalid, ...sample.invalid])];
    states.set(sample.state, entry);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify({ lane, selectors, states: Object.fromEntries(states), evidence: "Actual Chrome production components, QSA across intermediate open/hidden/modal/viewport states. Native classes and rollback fixture modes are separate from installed/native-host acceptance." }, null, 2));
  };
}
