# @pi-blackmagic/pi-settings

An independently loadable settings-center extension for **Pi 0.99.1**, currently
under implementation and acceptance testing. **`/pi-settings`** opens an
interactive full-viewport overlay; Pi's built-in `/settings` command is not
replaced. Non-interactive invocation reports that a terminal UI is required and
does not inspect or mutate configuration.

This `0.1.0` package is an **unpublished candidate**, not an available npm
installation. Registry scope/name ownership and license selection remain release
gates. It ships raw TypeScript under `src` and this README. Tests and fixtures are
development-only and excluded from the publish allowlist. Pi supplies the host
API through the `@earendil-works/pi-coding-agent` peer (`~0.99.1`); the host SDK is
not bundled. `@earendil-works/pi-tui` is also a direct host peer (`~0.99.1`);
`proper-lockfile` and the credential-blind `hosted-git-info` source parser are
explicit runtime dependencies.

## Baseline coverage

The reviewed inventory is
[`tests/fixtures/pi-0.99.1-coverage.json`](tests/fixtures/pi-0.99.1-coverage.json).
It contains all baseline native preference paths, named keybinding actions, MCP
configuration fields, and provider/model schema fields, including containers and
dynamic structured-entry paths. The inventory is reconciled against the installed
**0.99.1** declarations and schemas; it does not depend on which keys happen to
exist in a user's files.

| Inventory | Reviewed entries |
| --- | ---: |
| Native preference paths, including nested/container paths | 95 |
| Named keybinding actions | 90 |
| MCP root/server/OAuth paths | 23 |
| Provider/model/override paths, including compatibility metadata | 350 |

Native pages are General, Appearance, Models, Context, and Tools. Their catalog
includes absent/default-valued preferences, provider retries, thinking budgets,
per-model compaction overrides, resource/package declarations, terminal capability
overrides, and supported union values. Structured maps and lists remain typed;
coverage is not limited to Pi's built-in settings picker.

The native fields `deviceId`, `trackingId`, and `lastChangelogVersion` are
**host-maintained bookkeeping**, not editable preferences. They are preserved
when other entries change. Unknown future fields are also preserved, but are not
inferred as controls. The future-field fixtures live in
`tests/fixtures/unknown-future-fields.json`. This baseline inventory is not a claim
of automatic completeness for future Pi versions. New versions require reviewed
catalog/schema updates and conformance tests. Backend/UI reachability is a separate
acceptance gate; having an inventory does not mean the whole center is finished.

Global search indexes public descriptor identifiers, labels, descriptions, and
source/page labels, not configured/effective values or structured sensitive-field
metadata. Value masking is independent of metadata sensitivity: a credential-bearing
setting may have a safe searchable label, while sensitive descriptor metadata is
excluded entirely. Search covers all pages rather than just the current tab.

## Configuration locations and scopes

Resolve the user directory through Pi's public `getAgentDir()`; do not assume
`~/.pi/agent`. Project paths are relative to the command context's working
directory. Missing files mean empty configuration and are **not created on read**.

| Configuration | User scope | Project scope |
| --- | --- | --- |
| Native settings | `<agent-dir>/settings.json` | `<cwd>/.pi/settings.json`, trusted projects only |
| Keybindings | `<agent-dir>/keybindings.json` | Unsupported |
| MCP | `<agent-dir>/mcp.json` | `<cwd>/.pi/mcp.json`, trusted projects only |
| Providers/models | `<agent-dir>/models.json` | Unsupported |

Native `defaultProjectTrust`, `httpProxy`, and `cacheWarming` are user-only.
Untrusted project configuration is not read or written; unavailable project scope
is reported, never silently redirected to user scope. The host's early `sessionDir`
exception does not grant this extension permission to inspect untrusted project
configuration. The center does not edit `auth.json` or `mcp-auth.json`.

## Native inheritance and saved-versus-active state

Native scalar settings override by scope; nested objects merge recursively.
Per-model compaction values inherit independently by field. Resource/package lists
retain user and project declarations together, including `!pattern`, `+path`, and
`-path` expressions and each scope's relative-path meaning. This is the resource
loader's project-first two-layer composition, not the SettingsManager's ordinary
array merge. Package identities ignore npm versions and git refs, normalize
SSH/HTTPS repository forms, and resolve local paths from their declaring scope.
A project package replaces the same user identity unless `autoload: false` makes
it a filtering delta, in which case both declarations are retained. The center
shows declarations without scanning/installing packages or claiming their resources
are currently loaded.
`defaultTools` follows the host's special plain-name versus `+name`/`-name` rules.
Removing a project override restores the user setting or baseline default without
removing sibling fields. Environment-/model-dependent defaults that cannot be
known locally are not invented.

Read results distinguish the selected scope's configured entry, determinable
effective/inherited value, and a read-only host/session snapshot where supplied.
A differing host snapshot is labelled `host-override`: it may represent a runtime
or command-line override or host state that has not reloaded the saved file. It is
not evidence that a startup preference selected a current-session model.

`src/native-activation.ts` covers every native descriptor. Theme changes can use
Pi's supported UI theme operation; a failure after saving is **saved but not
active**, not a persistence failure. Startup model/thinking preferences and most
other native changes require explicit reload and never invoke session model or
thinking setters. Renderer mode, session directory, proxy/network initialization,
and trust fallback changes conservatively require restart. A separate
SettingsManager is used only as an in-memory test reference, never as the active
host manager.

## Keybindings

The Keybindings catalog includes all 90 baseline named actions, even actions with
no default assignment. Effective assignments come from the injected host manager,
not a newly constructed manager. User overrides can be one key, a list of keys,
or `[]` to disable an action. Removing an override restores its host defaults.
Configuration is user-only; writes preserve unrelated assignments and unknown
future actions. Saved changes require explicit `/reload`; the center does not
reload automatically. Potential shared-key conflicts are warnings, since overlap
between editor, fullscreen, tree, selector, and application contexts can be
legitimate.

Key capture uses the public Pi TUI parser. Text assignments accept baseline key
names and `ctrl`, `alt`, `shift`, and `super` modifiers, subject to terminal
capabilities. **Pi 0.99.1 limitation:** although its reference/types list `+` and
capture produces `+`/`ctrl++`, the host matcher cannot match those assignments.
The user-selected policy is to reject new plus-key assignments with an explicit
compatibility error, retain existing stored values, and leave Pi core unchanged.

## MCP and provider/model definitions

See [MCP configuration](docs/mcp.md) for complete stdio/HTTP/OAuth fields,
trusted project replacement rules, literal credential references, and explicit
reload requirements. Browsing does not launch or connect a server, and
`mcp-auth.json` is excluded.

See [provider/model configuration](docs/models.md) for complete provider, model,
override and compatibility metadata. These entries are user-only; `!command` and
environment references remain literal configuration. The center does not probe
endpoints, select the current session model, or manage `auth.json`.

The Models page offers searchable provider/model choices for startup defaults,
enabled-model items, per-model thinking keys, Add/rename provider, and provider form
model IDs, overrides, API types, and fallback references. Model choices follow
the saved provider and scope where appropriate. Type to filter, Up/Down to select,
and Enter to confirm; Tab or **Enter custom value…** allows custom IDs/patterns.
Known metadata comes from Pi's existing local catalog and configured definitions,
not authentication checks or provider requests. Newly saved definitions appear
without an automatic runtime reload. Availability and working credentials are not
implied by a catalog entry; numeric controls and existing fixed choices stay typed.

## Extensions registration

The Extensions tab contains only participating extensions. There are no legacy
adapters, inferred configuration files, or automatic third-party schema discovery.
The [version 1 registration protocol](docs/registration.md) documents raw event
channels, owner tokens, lifecycle cleanup and promise-based operations. Extensions
may optionally import the side-effect-free `@pi-blackmagic/pi-settings/registration`
helper; raw protocol consumers need no package dependency. Both load orders and
operation deadlines are supported. An indeterminate write requires read-back before
retry; a timeout is not a claimed rollback.

## Keyboard navigation and autosave

- **Left/Right** wrap through General, Appearance, Models, Context, Tools,
  Keybindings, MCP and Extensions tabs. **Up/Down** move one setting per press
  without changing values. **Tab** enters the selected setting's scope/reset/delete
  actions; Up/Down choose an action and Enter activates it. Tab or Escape returns
  to the settings list.
- Start **typing** to search metadata across every tab and participating extension;
  results show their source. **Backspace** edits the query. Left/Right retains the
  global query while changing the underlying tab.
- **Enter** opens the selected typed editor. Editor arrows and typing belong only
  to that editor, not tab navigation/search or the actions strip. Confirm scalar input with Enter;
  nested/list/map forms expose a **Complete entry** action. Valid completion
  autosaves that entry, not the whole settings center.
- **Escape** cancels incomplete editor input first. In browsing it clears a query
  before closing. Previously saved edits are never reverted. Deletion requires
  confirmation, and errors require acknowledgement.
- Closing waits for a bounded save outcome. Saved, saved-but-not-active, explicit
  reload/restart and indeterminate outcomes remain distinct. There is no global
  Save/Apply, undo, or automatic reload/restart.

Detailed editor controls are in [navigation](docs/navigation.md). The panel fills
all terminal rows with an opaque background, scrolls long pages, and adapts to
narrow/short terminals without changing Pi's renderer mode. Its presentation uses
a compact highlighted tab bar, a passive section index on wide terminals, grouped
human-readable labels, and aligned value columns. Scope/reset/delete actions are
shown once in the selected setting's contextual strip, not repeated throughout
the list; their keyboard focus is entered explicitly with Tab, keeping browsing
one-setting-per-arrow. Values preload through bounded, masked background reads,
not on search keystrokes; loading and unavailable/error states remain distinct.
Selected setting descriptions and provenance have dedicated footer rows. On narrow screens
the section index is hidden and the active tab remains visible. The layout is
inspired by the supplied OMP screenshot; no OMP code or assets are used.

## Persistence and safe editing

Each completed, valid entry is one acknowledged transaction. A per-path queue
serializes local mutations; `proper-lockfile` uses the baseline settings convention
(`realpath: false`, `<file>.lock`) with bounded acquisition retries. A plain local
filesystem adapter keeps the lock library's timestamp-precision cache off runtime
filesystem proxies, without changing native filesystem operations or weakening
locking. Trust is checked
again before reading/mutating, not only when an editor opens.

The writer re-reads under lock and compares the selected entry's semantic revision
with the editor baseline. **Unrelated external changes are retained**. A changed
selected entry is a conflict: refresh and re-edit rather than overwrite it. Rename
is a single transaction and rejects an occupied destination. Removing an override
removes only the selected entry, preserving unrelated fields and bookkeeping.

For example, if an editor loaded `theme: "system"` and an external writer changes
`quietStartup`, saving a new theme preserves that external change. If an external
writer changes `theme` itself, the save rejects and requires a refresh.

Existing malformed configuration is reported without replacing it with defaults.
Writes use a same-directory exclusive temporary file, flush it, preserve existing
permission bits where supported, and atomically replace the destination. New files
use restrictive permissions. Temporary files are cleaned up; replacement failure
does not fall back to truncating the target. Configuration reads and validation
must not launch processes, connect servers, probe providers, or resolve credential
commands.

Credentials and environment/header values are masked in ordinary displays. An
unchanged masked field retains its original value; deliberately replacing it with
an empty string is a distinct operation. Unknown structured fields are retained
without advertising their content. Errors do not interpolate raw values or backend
exception text. Synthetic fixtures, not personal configuration, exercise these
behaviors.

**Limitation:** locks coordinate only writers that honor the locking convention.
Entry revisions detect intervening changes seen at the locked re-read, but a
non-locking writer racing after that re-read cannot be guaranteed conflict-free.
Atomic replacement prevents this writer from producing a truncated file; it does
not make every external application cooperate. Windows and filesystem permission
semantics may differ from POSIX mode bits.

Successful persistence and active host state are separate outcomes. The UI
reports explicit reload/restart requirements without automatic reload,
global Apply/Save, or configuration undo. Cancelling incomplete input is not
reverting an earlier saved edit.

## Local use and verification

From the workspace root with dependencies installed, Pi and Nushell available:

```sh
nu packages/pi-settings/start.nu
```

The launcher defaults to **fullscreen**, offline, in-memory sessions, and a fresh
**temporary user configuration directory**. It disables discovered resources and
project trust, so test edits do not change your usual settings. It prints the
configuration directory and leaves it on disk for inspection. Open `/pi-settings`
after startup. Paths resolve relative to the launcher, so it also works from
another working directory.

```sh
nu packages/pi-settings/start.nu --mode regular
nu packages/pi-settings/start.nu --live
nu packages/pi-settings/start.nu -- --verbose
```

**`--live` uses your normal user configuration; valid edits autosave to those files.**
The launcher still runs offline and leaves project configuration untrusted.
It forwards extra Pi arguments after `--` and preserves Pi's exit code. This is a
local development launcher, not part of the package's publish allowlist.

Direct startup is also available (uses your normal configuration):

```sh
pi --no-extensions --extension ./packages/pi-settings/src/index.ts --tui-mode fullscreen
```

Alternatively, load the `pi-blackmagic` suite entrypoint, which includes this
member. **Do not load the standalone member and the suite simultaneously.**

Run `bun test`, `bun run typecheck`, `bun run lint`, and `bun run fmt:check` from
the workspace. The inventory tests use the pinned **TypeScript 7** native API and
AST exports with isolated virtual projects; no older compiler/parser is required.
Tests use temporary directories and synthetic configuration and require no model
credentials. Unit checks are not a substitute for the remaining UI integration
and regular/fullscreen host smoke-test acceptance gates.
