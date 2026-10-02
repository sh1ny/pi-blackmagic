# Design

## Context

See proposal.md for motivation. The current repository has only .pi/, .omp/, and openspec/; there is no implementation or existing package contract to migrate. OpenSpec has no capability specs or active changes other than this foundation change. This is a cross-cutting tooling and distribution layout decision, so a design is warranted; product delta specs are intentionally skipped.

Verified local tools are Bun 1.4.2 via mise, Node 24.21.0 via Scoop, and mise 2026.9.12. Pi 0.99.1 is installed separately. pnpm is not on PATH. Pi package docs support Bun-managed dependencies, explicit pi resource manifests, and raw TypeScript extension entrypoints. User-approved distribution is both individual packages and an entire suite.

## Goals / Non-Goals

**Goals:**
- Keep each future extension independently installable without relying on suite-only initialization.
- Give developers and future CI the same named, credential-free check commands.
- Keep package runtime code compatible with Pi rather than assuming Bun runtime APIs are available inside extensions.
- Verify the composition and artifact layout without claiming settings features exist.

**Non-Goals:**
- Implement a settings UI, persistence, commands, or configuration discovery.
- Create a shared core, release automation, an actual CI workflow, npm publications, or new global installations.
- Change developer credentials, global settings, or .pi/.omp resources.
- Guarantee duplicate-registration handling for separately installed physical copies of suite and standalone packages; no runtime tools are registered by this skeleton.

## Decisions

### 1. One private workspace and two public package candidates

Use root package.json with workspaces covering packages/* and a committed bun.lock. The root stays private. Create packages/pi-settings and packages/blackmagic; do not create a root meta directory or shared core.

Use proposed manifest names @pi-blackmagic/pi-settings and pi-blackmagic, initial versions 0.1.0, with no publish performed. Namespace ownership and registry availability must be confirmed before release, not implied by this scaffold.

Each package uses explicit files allowlists and a pi.extensions entry pointing at src/index.ts. Avoid listing tests or development state in published artifacts. Do not invent licensing terms; defer license selection until the owner chooses one.

Alternative: a single aggregate package is simpler to release but does not satisfy separately installable extensions. A separate root meta workspace is valid but less consistent than placing all release units under packages/.

### 2. Thin composition, no product behavior

pi-settings exports a standard default Pi extension function that is deliberately inert. The umbrella imports the pi-settings default entrypoint by its declared package name and calls it with the same Pi ExtensionAPI. It depends on @pi-blackmagic/pi-settings using workspace:*; individual extensions never depend on the umbrella.

Expose a package export for the TypeScript entrypoint so local workspace resolution and the future installed suite use the same import. Bundled defaults, settings storage, and runtime registrations are omitted until a pi-settings feature change defines them. An inert entrypoint is a scaffold, not a usable settings extension.

Alternative: manually copy source into the suite would blur ownership and release boundaries. Loading dependency resources implicitly is insufficient; the umbrella must explicitly compose its declared dependency.

### 3. mise owns toolchain and public tasks; Bun owns dependencies

Add mise.toml pinning Bun 1.4.2 and Node 24.21.0, the locally verified versions. mise install supplies these project-scoped tools without changing global defaults. No pnpm config is added. Existing developer Pi remains a documented prerequisite for dev tasks; do not silently install or update it.

Task interface:
- setup: bun install --frozen-lockfile after the initial lockfile is generated during implementation.
- fmt:check: formatting validation, without writes.
- fmt:fix: explicit formatting writes.
- lint: lint validation, without writes.
- typecheck: TypeScript no-emit validation.
- test: Bun's credential-free unit/structural tests.
- check: depends on fmt:check, lint, typecheck, and test, allowing independent tasks to run concurrently.
- dev:pi-settings: launch Pi with --no-extensions and the explicit standalone entrypoint.
- dev:suite: launch Pi with --no-extensions and the explicit umbrella entrypoint.

Use short portable commands, with no Bash-only constructs, shell glob expansion, or hard-coded user paths. If launch argument forwarding needs logic, use a small portable TypeScript helper. Avoid forced Bun runtime behavior for the Pi executable.

Future CI performs mise install, mise run setup, then mise run check. Do not add a GitHub Actions workflow yet. Native dependency lifecycle scripts must be reviewed explicitly if introduced; they are not needed for this skeleton.

### 4. Shared static checks, package-local tests

Use a shared strict tsconfig.base.json and a root no-emit typecheck configuration covering package source and tests. Resolve workspace packages through their manifests, not paths aliases that hide broken package exports. Add exact development dependency versions and lock them in bun.lock. Pi host packages imported by distributed packages belong in peerDependencies with * ranges, with local SDK types provided as development dependencies only.

Use Biome for formatting and lint, scoped to new workspace tooling/source rather than reformatting existing .pi/, .omp/, or OpenSpec files. Use Bun tests colocated with each package to check the inert standalone entrypoint, exactly-once umbrella composition in a single invocation, and manifests/resource paths. Keep package-specific runtime dependencies in their owning package. Raw TypeScript is shipped initially; no dist build is required.

Bun tests validate scaffold contracts, not full Pi host compatibility. During implementation, also perform a local credential-free Pi load smoke test for both entrypoints using a documented CLI mode that initializes extensions without a model prompt; if host initialization cannot be exercised without inference, document the limitation rather than silently treating Bun tests as equivalent. Live model calls are outside normal checks.

### 5. Document package boundaries and release readiness

Add a concise root README, package READMEs, and docs/decisions/0001-monorepo-layout.md. Explain fresh-clone setup, task meanings, independent/suite paths, no-op pi-settings status, host peer dependencies, and future publishing caveats. Add ignores for node_modules, build output, caches, and test artifacts; do not ignore the lockfile or source development-agent definitions.

Bun publishing rewrites workspace protocols, but release acceptance must inspect packed manifests and included files. Local tarball inspection is safe; no registry upload is authorized. Do not advertise installation as currently available on npm.

## Risks / Trade-offs

- [Bun and Pi may differ in module loading] -> Keep extensions host-compatible and supplement Bun tests with an actual local Pi initialization smoke test.
- [Suite and standalone may register twice when users install both] -> Document that the suite already includes its members. Design runtime idempotency when actual registration behavior is introduced, not a global singleton now.
- [Public package names may be unavailable] -> Treat names as proposed; check ownership before release.
- [Pinned local versions become outdated] -> Upgrade deliberately through reviewed toolchain and lockfile changes rather than using latest aliases.
- [A read-only check might accidentally mutate files] -> Separate fmt:fix and validate check by comparing workspace contents before/after.
- [Native scripts or inconsistent shells cause Windows/CI failures] -> Keep the initial dependencies pure tooling and commands portable; test on Windows now, with Linux CI verification deferred until CI is added.

## Migration Plan

This is additive scaffolding, not a migration. Create workspace/configuration files, generate the lockfile with the pinned Bun, add package entrypoints and checks, and document the commands. Run frozen setup and the entire check suite, inspect package artifacts, and smoke-test Pi entrypoints without inference. Rollback removes only the newly introduced foundation files; existing .pi/, .omp/, and OpenSpec resources remain intact.
