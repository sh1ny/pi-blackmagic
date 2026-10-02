# 0001: Bun workspaces with mise and a thin suite package

Status: accepted for repository scaffolding. Public package names are provisional.

## Decision

Put every release unit under `packages/`: first `pi-settings`, then the `blackmagic` umbrella. Use a private root Bun workspace and commit its lockfile. Use mise to pin Bun/Node and expose portable local/CI tasks. Keep TypeScript extension entrypoints unbuilt initially.

The suite explicitly imports and initializes its declared members. Members must work without suite-only infrastructure and never depend on the suite. Shared code is extracted only when actual reuse justifies it; there is no speculative `core` or global event bus.

Keep `.pi/`, `.omp/`, and OpenSpec development state separate from published artifacts. Each published package uses an explicit Pi resource manifest and source/README allowlist. Pi host modules are wildcard peer dependencies; local SDK types are development dependencies.

## Alternatives

- A single aggregate package simplifies publication but cannot provide the desired independent installation surface.
- A separate root `meta/` is viable, but puts release units under two workspace patterns unnecessarily.
- pnpm is viable, but Bun is already installed and supports workspaces and publishing; there is no current need for another package manager.
- A shared core now would anticipate requirements we have not established.

## Checks and host compatibility

mise's `check` depends on formatting validation, lint, no-emit TypeScript checks, and Bun tests. Dependencies can run concurrently. It must not modify source or lockfiles; explicit formatting fixes are separate. Initial tests cover scaffold structure/composition and launch arguments, not settings behavior.

Distributed extensions run inside Pi, not necessarily Bun. Verify host initialization separately without inference; do not call Bun unit tests proof of host compatibility. Future CI uses the same setup/check commands. Linux CI coverage, an actual CI workflow, and model-backed integration tests are not included in this foundation.

## Consequences

Independent packages and the umbrella can eventually be published separately. Bun's packing/publishing tools must rewrite workspace dependency references and package artifacts must be inspected before release. npm scope/name availability, licensing, and pi-settings features remain release gates.

The pi-settings scaffold is deliberately inert. Users should load either the suite or individual members, not overlapping copies. A concrete duplicate-registration policy belongs to future functionality, not this no-op foundation.
