import assert from "node:assert/strict";
import { test } from "node:test";
import { auditSources } from "../scripts/audit-legacy-remnants.js";

const browser = "src/web-ui/browser/example.ts";
const react = "src/web-ui/react/example.tsx";
const scan = (text: string, markup = "") => auditSources([
  { path: browser, text }, { path: react, text: markup },
]);

test("remnants audit attributes queries by AST scope, not the preceding variable/function", () => {
  const report = scan(`
    function outer() {
      function nested() { document.querySelector('.nested'); }
      const unrelated = 1;
      document.querySelector('.outer');
    }
    document.getElementById('root');
  `);
  assert.equal(report.candidates.find((c) => c.token === ".nested")?.sites[0].owner, "nested");
  assert.equal(report.candidates.find((c) => c.token === ".outer")?.sites[0].owner, "outer");
  assert.equal(report.candidates.find((c) => c.token === "#root")?.sites[0].owner, "<top-level>");
});

test("remnants audit ignores source comments and selector-like attribute values", () => {
  const report = scan(`
    // document.querySelector('.fake');
    /* element.className = 'missing'; */
    document.querySelector('.missing[href="file.ts#section"]');
  `);
  assert.deepEqual(report.candidates.map((c) => c.token), [".missing"]);
});

test("remnants audit recognizes literal JSX, DOM writes and HTML templates", () => {
  const report = scan(`
    document.querySelector('.jsx'); document.getElementById('host');
    document.querySelector('.written'); document.querySelector('.html');
    document.querySelector('.attribute');
    el.className = 'written'; el.id = 'host';
    el.setAttribute('class', 'attribute');
    el.innerHTML = '<div class="html"></div>';
  `, `const node = <div className={classNames('jsx', active && 'selected')}/>;`);
  assert.deepEqual(report.candidates, []);
});

test("remnants audit includes bare classList arguments without treating removals as producers", () => {
  const report = scan(`
    el.classList.remove('old', 'other');
    el.classList.contains('present'); el.classList.add('present');
    el.classList.replace('old', 'new'); el.classList.contains('new');
  `);
  assert.deepEqual(report.candidates.map((c) => c.token), [".old", ".other"]);
});

test("remnants audit reports dynamic queries as unparsed, not confirmed missing", () => {
  const report = scan(`document.querySelector('.prefix-' + scope);`);
  assert.equal(report.dynamicQueries, 1);
  assert.deepEqual(report.candidates, []);
});

test("remnants audit joins constant selector fragments and records CSS separately", () => {
  const report = auditSources([
    { path: browser, text: `document.querySelector('.long' + '-path');` },
    { path: "src/web-ui/content/styles.css", text: `.long-path:hover { color: red; }` },
  ]);
  assert.equal(report.candidates[0].token, ".long-path");
  assert.equal(report.candidates[0].hasCss, true);
  assert.equal(report.candidates[0].sites.length, 1);
  assert.equal("live" in report.candidates[0].sites[0], false);
});
