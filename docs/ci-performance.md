# CI performance

## Kept guarantees

The default `CI / verify` check runs on macOS 26, checks all three TypeScript projects and the browser bundle, and generates cross-platform brand icons. The former automated test suite and its unit/browser partitions have been removed; CI no longer runs them.

Stable and beta npm releases keep the shared `npm-publish` lock, pinned Render binary verification, explicit build, `--ignore-scripts`, and their `latest`/`beta` channels. `scripts/publish-npm.js` confirms both the version and intended dist-tag from one anonymous registry response. Requests have distinct query keys and no-cache headers so a polling cycle does not keep reusing the same representation. This mitigates a suspected stale metadata response; the historical logs alone do not establish the cache layer responsible.

A successful publish is never repeated during read propagation. Failed writes retain five attempts with backoff; if a failed write nevertheless became visible, only the intended dist-tag is repaired. Verification polls at ten-second intervals for up to six minutes and fails if either fact stays unconfirmed. No real release was made to benchmark this path.

## Cache scope

Node workflows cache npm downloads by the lockfile and retain `npm ci` plus integrity verification. Beta runs on the default branch can seed the Linux cache used by stable releases. The macOS CI cache is separate.

Android caches Gradle dependency downloads keyed by build definitions, wrapper and properties. macOS/iOS cache only SwiftPM dependency downloads keyed by the platform's checked-in `Package.resolved`; they still rebuild, test, sign and package the native clients. No credentials, `node_modules`, signed package or versioned product is cached. Caches are optional: a miss follows the existing fresh-download path.

GitHub cache access is ref-scoped. A cache from a previous tag cannot automatically seed a different tag. Native caches therefore primarily benefit reruns of the same tag or runs with a matching default-branch cache created by an authorized manual build. They do not guarantee a warm cache on every release.

Runner class, permissions, release upload conditions and cleanup policy are unchanged. Ordinary push/PR CI now gates the business/unit scope; manual dispatch can additionally request UI regression. This is an explicit test-policy change, not a claim that earlier browser failures passed. Outdated CI and beta runs retain existing cancellation; release runs remain uncancelled to preserve publication.
