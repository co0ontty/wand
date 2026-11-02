# CI performance

## Automatic and manual workflows

| Event | Workflows |
| --- | --- |
| Push to `master` / pull request | One Linux `CI / verify` job |
| Stable `vX.Y.Z` tag | NPM Publish, Release Notes, Android APK Release, macOS Release |
| Manual only | iOS IPA Build, Beta NPM Publish, macOS Beta Release |
| Published release / manual cleanup | Cleanup Old Release Assets |

The scheduled tag-creation workflow has been removed. A new stable release starts with an explicit tag push. iOS builds never start automatically on a commit or tag; even a manual run against a tag only publishes its IPA when `publish_release=true`.

Historical Actions runs remain visible after triggers are removed. Workflow-created events using `GITHUB_TOKEN` do not start another workflow, so release-asset cleanup may need an explicit manual run when Release Notes creates the release with that token.

## Kept guarantees

`CI / verify` uses the Node version in `.nvmrc` and checks out only `render-bin`. It builds the npm package, including server TypeScript declarations, generated Web assets and the bundle budget, then checks the browser and React TypeScript projects without rebuilding the same assets. Finally, it verifies all pinned Render binaries with SHA/container checks. The check name remains `verify`.

The former automated test suite and its unit/browser partitions have been removed. CI therefore no longer installs an independent Pi CLI, generates native AppIcon PNGs, builds Rust for nonexistent protocol tests, uploads nonexistent browser-test evidence or offers an unused `ui_regression` input. There is no Node compatibility matrix on every push. Native builds remain in their platform workflows; Rust tests remain in the Render source repository's CI.

Stable and beta npm releases keep the shared `npm-publish` lock, pinned Render binary verification, explicit build, `--ignore-scripts`, and their `latest`/`beta` channels. `scripts/publish-npm.js` reads the version document and dist-tags endpoints anonymously instead of polling the entire packument. Requests have distinct query keys and no-cache headers; credentials are used only by npm writes. A 404 version response means not yet visible, while other registry errors keep verification pending.

A successful publish is never repeated during read propagation. Failed writes retain five attempts with backoff; if a failed write nevertheless became visible, only a missing or older intended dist-tag is repaired. A version is confirmed only after its tarball URL also returns HTTP 200; delayed metadata/blob propagation retains the known version and waits without uploading it again. When that stable version is downloadable and `latest` already names a higher stable version, verification succeeds without moving `latest` backwards. Attempting to publish an absent older stable version over a newer `latest` is rejected. Verification polls at ten-second intervals for up to fifteen minutes and fails if availability remains unconfirmed. Publishing jobs have a twenty-minute timeout.

## Cache scope

Node workflows cache npm downloads by the lockfile and retain `npm ci` plus integrity verification. Linux default-branch CI can seed the cache used by stable npm releases.

Android caches Gradle dependency downloads keyed by build definitions, wrapper and properties. macOS/iOS cache only SwiftPM dependency downloads keyed by the platform's checked-in `Package.resolved`; they still rebuild and package the native clients. No credentials, `node_modules`, signed package or versioned product is cached. Caches are optional: a miss follows the fresh-download path.

GitHub cache access is ref-scoped. A cache from a previous tag cannot automatically seed a different tag. Native caches primarily benefit reruns of the same tag or runs with a matching default-branch cache created by an authorized manual build. They do not guarantee a warm cache on every release.

Outdated ordinary CI runs retain automatic cancellation. Publication jobs retain the shared lock without cancellation to avoid interrupting a release in progress. Removing the old daily release workflow does not interrupt Render or native release workflows in their own repositories.
