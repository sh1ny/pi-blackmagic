# Tasks

## 1. Bun workspace and pinned toolchain

- [x] 1.1 Add the private root package.json, packages/pi-settings/package.json, and packages/blackmagic/package.json with explicit TypeScript exports, Pi resource manifests, files allowlists, and the suite's workspace dependency; verify Bun resolves both workspace names and no standalone package depends on the suite.
- [x] 1.2 Add mise.toml pinning Bun 1.4.2 and Node 24.21.0 without altering global defaults; verify mise reports the selected project versions after mise install and record any installation blocker rather than substituting latest.
- [x] 1.3 Add exact development dependency versions, correct Pi host peer dependencies, a committed bun.lock, and ignores for generated artifacts; verify the initial Bun install succeeds, a subsequent frozen install leaves the lockfile unchanged, and published package manifests contain no host modules in runtime dependencies.
- [x] 1.4 Document fresh-clone setup and workspace/package boundaries in the root README and docs/decisions/0001-monorepo-layout.md; verify the documented commands work locally and clearly identify npm names as unpublished candidates.

## 2. Standalone pi-settings and suite skeletons

- [x] 2.1 Add the deliberately inert default pi-settings extension entrypoint and package-local tests; verify invoking it with a minimal host test fixture registers no tools, commands, settings UI, or persistence behavior.
- [x] 2.2 Add the thin umbrella entrypoint importing pi-settings through its package export and forwarding the same Pi API; add a test seam or suitable test fixture to verify one suite invocation initializes the member exactly once without source duplication or undeclared imports.
- [x] 2.3 Add package-local manifest/resource tests; verify every pi entrypoint and export exists, test files are excluded by publishing allowlists, and both packages declare their actual imports.
- [x] 2.4 Add concise package READMEs describing standalone versus suite use, the no-op pi-settings status, and avoiding simultaneous suite/member loading; verify no documentation claims implemented settings behavior or existing npm availability.

## 3. Portable checks and isolated development tasks

- [x] 3.1 Add strict shared TypeScript configuration and a root no-emit check covering source/tests; verify typecheck succeeds through workspace package exports and deliberately invalid source makes it fail without generating output.
- [x] 3.2 Add Biome formatting/lint configuration scoped to the new workspace tooling and source; verify fmt:check and lint are read-only, fmt:fix is explicitly separate, and existing .pi/.omp/OpenSpec metadata is not rewritten.
- [x] 3.3 Define mise setup, fmt:check, fmt:fix, lint, typecheck, test, and check tasks with portable commands and parallel-safe dependencies; verify setup uses the frozen lockfile, all component tasks succeed, check propagates a failing component's exit status, and tests require no model credentials.
- [x] 3.4 Define dev:pi-settings and dev:suite tasks using --no-extensions with explicit entrypoints and a documented existing Pi prerequisite; verify command construction isolates the intended entrypoint and argument forwarding does not force Pi into Bun or require Bash.
- [x] 3.5 Document the local/CI task sequence, formatting-fix separation, Pi development prerequisite, and optional live-test boundary; verify task names match mise's task inventory and do not claim a CI workflow has been added.

## 4. Foundation integration verification

- [x] 4.1 Run mise run setup followed by mise run check on Windows and compare source/configuration/lockfile contents before and after; verify successful checks do not alter tracked inputs and report Linux CI coverage as not yet executed.
- [x] 4.2 Exercise both explicit entrypoints in the installed Pi host without a model request using a documented initialization mode; verify host initialization succeeds with no extension errors or credential use, or explicitly document the precise host-test limitation if initialization cannot be verified without inference.
- [x] 4.3 Inspect locally packed artifacts for both packages without publishing; verify resource files are included, development state/tests are excluded, and the suite's workspace dependency is rewritten into an installable version reference by Bun packing/publishing tooling.
- [x] 4.4 Review the completed foundation against the design and report remaining release gates: registry name/scope ownership, license selection, pi-settings feature design, duplicate-loading behavior once registrations exist, and actual CI workflow addition; verify these are not presented as completed functionality.
