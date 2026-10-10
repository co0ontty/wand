# CI performance

## Kept guarantees

The `CI / verify` check still runs on macOS 26, checks all three TypeScript projects and the browser bundle, generates the cross-platform brand icons, and runs every `tests/*.test.ts` file. `scripts/run-ci-tests.js` schedules files containing `WAND_BROWSER_E2E` in one browser worker and all other files in two unit workers on the same runner. Mixed unit/browser files stay intact. Both groups finish, and either nonzero exit fails the check. Existing opt-in flags and skips stay unchanged.

Stable and beta npm releases keep the shared `npm-publish` lock, pinned Render binary verification, explicit build, `--ignore-scripts`, and their `latest`/`beta` channels. `scripts/publish-npm.js` confirms both the version and intended dist-tag from one anonymous registry response. Requests have distinct query keys and no-cache headers so a polling cycle does not keep reusing the same representation. This mitigates a suspected stale metadata response; the historical logs alone do not establish the cache layer responsible.

A successful publish is never repeated during read propagation. Failed writes retain five attempts with backoff; if a failed write nevertheless became visible, only the intended dist-tag is repaired. Verification polls at ten-second intervals for up to six minutes and fails if either fact stays unconfirmed. No real release was made to benchmark this path.

## Cache scope

Node workflows cache npm downloads by the lockfile and retain `npm ci` plus integrity verification. Beta runs on the default branch can seed the Linux cache used by stable releases. The macOS CI cache is separate.

Android caches Gradle dependency downloads keyed by build definitions, wrapper and properties. macOS/iOS cache only SwiftPM dependency downloads keyed by the platform's checked-in `Package.resolved`; they still rebuild, test, sign and package the native clients. No credentials, `node_modules`, signed package or versioned product is cached. Caches are optional: a miss follows the existing fresh-download path.

GitHub cache access is ref-scoped. A cache from a previous tag cannot automatically seed a different tag. Native caches therefore primarily benefit reruns of the same tag or runs with a matching default-branch cache created by an authorized manual build. They do not guarantee a warm cache on every release.

No workflow trigger, runner class, permissions, release upload condition, test gate or cleanup policy changed. Outdated CI and beta runs retain existing cancellation; release runs remain uncancelled to preserve publication.

## Baseline measured on 2026-10-09

The most recent 100 runs were sampled, with an additional latest ten per workflow to include low-frequency workflows. Workflow elapsed time includes queue/concurrency waiting; step time comes from the jobs API.

| Workflow | Successful sample median | Latest relevant steps |
| --- | ---: | --- |
| NPM Publish | 10m22s (12 runs) | v4.89.0 job 4m19s; npm publication 217s; approximately 6m of lock/queue waiting |
| macOS Release | 6m44s (15 runs) | v4.89.0 job 410s; tests + Universal build + package 387s |
| Beta NPM Publish | 6m03s (12 runs) | master job 362s; npm publication 315s |
| Android APK Release | 4m45s (15 runs) | v4.89.0 job 302s; Gradle build 276s |
| CI | 5m45s (one old successful run) | latest PR job failed at 696s: tests 572s, check 58s; current master failed at 636s: tests 540s |
| iOS IPA Build | 30s (12 runs, includes reused IPAs) | last full successful build v4.84.0: 1086s; test compilation 148s, simulator 505s, IPA 413s |
| Release Notes | 15s (15 runs) | v4.89.0 13s |
| Cleanup Old Release Assets | low frequency | latest run 59s; no change |
| macOS Beta Release | no runs | no historical timing claim |

The iOS median is not a cold-build estimate. The most recent three iOS releases failed in test compilation, and current baseline CI has existing failing cases. OpenRouter/core fixtures now create their unique temporary directories under the OS temporary root, removing the clean-checkout dependency on the ignored `output/openrouter` folder without changing assertions. Other failures remain visible; no check was removed to improve timing.

Expected gains are estimates until observed remotely: isolating Chrome from unit/daemon contention should shorten the CI critical path; npm download reuse should save part of the existing 19–25s install step; fresh publication reads and shorter poll intervals should reduce the existing 217–315s wait when registry data is available. Cold native compilation remains substantial. Native download-cache gains are limited by the ref rules above. New timings and validation results belong in the PR run evidence rather than being presented as a promised speedup.

## Final local verification

After fixture repairs, the complete372-file grouping was rerun twice. The final run starts with no tool-switch screenshot directory:2629 tests,2570 pass/3 fail/56 skip. Unit runner189.75s/browser236.84s; command wall236.93s. check/build,8 targeted tests, both JS syntax checks and all9 actionlint workflows pass. The runner now logs each group's time and total wall time without changing failure propagation.

A serial six-file unchanged-base diagnosis, using the same Node, dependency tree and pinned Render with matched generated prerequisites, reproduces all3 remaining failures: Render coalescing threshold1397 vs<500, a removed tool-timeline selector, and synthetic team-delivery chat context. It also reproduces29 original fixture-directory failures and the tool-switch screenshot directory failure; these directory issues are fixed without assertion changes. The final complete run passes those fixtures. No grouping-introduced failure was observed; the full suite is still not green. Baseline comparison is targeted diagnosis, not a full-suite speed benchmark. See output/ci-performance/validation.md and final-validation-summary.json for commands and limitations. No Git/remote writes or deployment occurred.
