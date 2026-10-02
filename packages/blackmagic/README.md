# pi-blackmagic

A thin Pi suite **no-op scaffold** that imports `@pi-blackmagic/pi-settings` through
its package export and calls it with the same host API. The member is deliberately
inert: no settings UI, storage, commands, or tools are implemented. The suite's
raw TypeScript entrypoint is `src/index.ts`, declared in both `exports` and
`pi.extensions`.

This `0.1.0` package is an **unpublished candidate**, not an available npm
installation. Registry name/scope ownership and license selection must be resolved
before release. The suite declares its member as a `workspace:*` dependency;
release artifact inspection must verify conversion to an installable version.
Pi provides the `@earendil-works/pi-coding-agent` host peer; it is not bundled.

## Local use

From the workspace root, after the workspace dependencies are installed and with
Pi already available:

```sh
pi --no-extensions --extension ./packages/blackmagic/src/index.ts
```

Load the suite for its included members, or load `pi-settings` independently.
**Do not load the suite and its standalone member simultaneously.** No global
singleton or duplicate-loading guard is provided; future registrations could run
twice when both are loaded.

Only `src` and this README are allowlisted package contents. Package-local Bun
tests under `tests` verify inert behavior, exactly-once composition with identical
API forwarding, and manifest contracts without model credentials or global
module mocks. They do not establish full Pi host compatibility.
