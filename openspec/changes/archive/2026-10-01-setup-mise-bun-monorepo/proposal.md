# Proposal

## Why

The repository currently contains development-agent metadata and an empty OpenSpec setup, but no workspace, extension packages, dependency lockfile, or checks. Establish a small, reproducible foundation for separately published Pi extensions and an optional full-suite installation. Use the already installed Bun and mise rather than introducing pnpm. The first extension package is pi-settings, not subagents.

## What Changes

- Create a private Bun workspace with packages/pi-settings and packages/blackmagic, the latter a thin suite entrypoint depending on the former.
- Add a loadable, deliberately inert TypeScript pi-settings skeleton; define no settings features in this change.
- Pin Bun and Node in mise.toml and expose dependency setup, read-only checks, formatting fixes, and isolated Pi development launch tasks.
- Add shared TypeScript and formatting/lint configuration, a small credential-free test suite, and a committed Bun lockfile.
- Document independent versus suite installation, package boundaries, local setup, and the checks CI will call later.
- Preserve .pi/, .omp/, and existing OpenSpec tooling. Do not introduce speculative shared-core packages.

## Capabilities

### New Capabilities

None. This change establishes tooling and package skeletons, without implementing pi-settings product behavior. Delta specs are explicitly skipped through skip_specs: true.

### Modified Capabilities

None; there are no existing capability specs.

## Impact

New root tooling files, documentation, and two package skeletons. Development dependencies include TypeScript, formatting/lint tooling, and Pi SDK types. Host-provided Pi modules remain peer dependencies of distributed packages. No credentials, global Pi settings, global tool installations, or existing development extensions are changed. No npm publishing or GitHub Actions workflow is performed in this foundation change; checks are designed to be usable in CI later.
