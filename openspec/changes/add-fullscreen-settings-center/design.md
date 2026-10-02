# Design

## Context

See proposal.md for motivation and the three delta specs for behavior contracts. This design qualifies because it introduces a cross-cutting UI/backend architecture, public protocol, and security-sensitive configuration persistence.

Observed repository state:
- `packages/pi-settings/src/index.ts` is an inert factory. `tests/extension.test.ts` explicitly rejects all host API access. `tests/manifest.test.ts` assumes only the root export and that every external import is a declared host peer.
- `packages/blackmagic/src/index.ts` composes pi-settings; the standalone package must not depend on the umbrella.
- Workspace scripts are Bun tests, TypeScript checking, and Biome lint/format checks. Development SDK baseline is Pi 0.99.1, while the scaffold currently declares an unrestricted host peer.
- Installed extension declarations expose `pi.getSettings()` (effective copy), `pi.events`, runtime model/thinking/tool APIs, and custom UI, but not the active host SettingsManager or a generic persistent setter.
- Pi's root export includes `getAgentDir`, `SettingsManager`, and configuration-related public types. An independently created SettingsManager is not the host's live manager.
- Pi reserves built-in slash commands; a new `/pi-settings` command avoids ambiguous `/settings` dispatch.
- Native settings have user/project merge and resource-list semantics. Keybindings and models definitions are agent-directory configuration only. Project settings and MCP files are trust-gated, with the host's early sessionDir exception not granting the extension permission to read other untrusted project fields.
- Pi settings storage uses `proper-lockfile` with `realpath: false`. pi-tui overlays support percentage width/height caps, but maxHeight only clips returned lines; it does not fill the viewport.

## Goals / Non-Goals

**Goals:**
- Separate rendering, descriptor catalogs, validation, persistence, and activation so each can be tested without model credentials.
- Make baseline completeness measurable instead of equating coverage with existing keys found in a user's files.
- Treat each completed edit as one bounded, acknowledged transaction, without a global pending-change set.
- Keep the public registration protocol usable by extensions without forcing a package dependency or load-order convention.

**Non-Goals:**
- No legacy plugin adapters, arbitrary source/file discovery, Pi core fork, authentication-store editor, or implementation of other extensions' configuration.
- No automatic reload/restart, global Apply/Save, or configuration undo/history feature.
- No requirement to clone every OMP visual element, add a preview panel, support mouse interaction in regular mode, or pause the agent merely because settings are visible.
- No network probes, model calls, MCP process launches, package installs, or evaluation of credential commands from browsing or validating settings.

## Decisions

### 1. One catalog over subsystem-specific backends

Create proposed modules under `packages/pi-settings/src/`: catalog/types, native/keybinding/MCP/model backends, shared persistence/redaction, registration protocol/registry, and UI controller/components. Keep `index.ts` as lifecycle/command wiring; add a side-effect-free `./registration` export for protocol types and an optional helper.

Use stable descriptor identities containing provider, page, and setting path. Descriptors contain label/help, edit kind, validation constraints, scope capabilities, sensitivity, provenance, and activation metadata. Backends return persisted/effective value information and acknowledged outcomes, not UI-formatted strings.

Native settings are an explicit versioned catalog derived from baseline settings declarations and reference documentation, including absent settings and all supported nested structures. Exclude host identity/bookkeeping fields such as trackingId, deviceId, and lastChangelogVersion from editable preferences while preserving them. Ship a reviewed coverage fixture matching supported public settings fields and baseline keybinding, MCP, and model/provider schema fields. A JSON-object editor is a fallback for complex supported subtrees, not an excuse to omit documented fields, descriptions, or validation.

Alternative: generate controls from whatever keys exist in files. Rejected because missing default-valued settings disappear and semantics cannot be inferred reliably.

### 2. Full-viewport custom overlay, not a second renderer

Register `/pi-settings`, guard `ctx.mode === "tui"`, create a fresh component through `ctx.ui.custom()`, and use width `100%`, maxHeight `100%`, top-left anchor, zero margin. Render exactly the current terminal height, padding every row to viewport width with the panel background. Reserve rows for title/tabs, content, selected-item help, and status/key hints. Body scrolling is bounded independently of the viewport; use pi-tui width utilities for ANSI/wide-character safety.

Top-level proposed tabs: General, Appearance, Models, Context, Tools, Keybindings, MCP, and Extensions. Additional sections can be grouped under the relevant tab rather than adding a top-level tab per plugin. Do not require a separately focused sidebar: Up/Down traverses page settings, including extension page-entry rows where necessary. Narrow terminals scroll/truncate the tab strip while retaining an active-tab indication; very short terminals use a compact view with accessible selected-row/status content.

Finish via the provided done callback, dispose the component, and let Pi restore focus. Never manually clear the renderer or call hide() on a custom-UI-owned overlay. Track pending saves before normal close. Render background changes through Pi's requestRender; do not add a second terminal loop.

Alternative: inline SettingsList or replacement editor. Rejected because neither by itself guarantees coverage of chat/header/footer.

### 3. Separate browse, global-search, edit, and saving states

Input ownership is explicit:
- Browse: Left/Right cycles tabs (wrapping at ends); Up/Down selects rows (clamped at ends); Enter activates the selection. Scope and reset-to-inherited are visible entry actions activated with Enter.
- Search: printable typing creates/extends a query immediately; Backspace edits it. Match case-insensitively across descriptor identifiers, labels, descriptions, and source/page labels, never values or sensitive fields. Results include source labels and are global across every tab and participating extension. Up/Down traverses results; Enter edits the result. Left/Right changes the underlying active tab while retaining global results and query; clearing search restores that tab and its remembered selection.
- Edit: the selected control exclusively owns printable input and arrows. Enter confirms a scalar value or selected choice. Structured forms have a visible Complete-entry action; activating it autosaves the validated entry, not the entire settings center. Escape cancels only the incomplete entry.
- Saving: serialize edits per backend file or plugin provider; show acknowledgement/errors and prevent stale late results from replacing newer state. Escape from browsing clears a nonempty query before closing. Closing waits for pending saves and exposes failures for acknowledgement; previously saved edits are never reverted.

Provider/model text leaves use advisory searchable choices from the host's existing
synchronous public metadata snapshot, registered provider IDs, and public model
IDs/names/API types from already-read user models.json. The suggestion resolver is
an internal UI adapter, not a restriction on the persistence or registration schema.
Default model choices follow the freshly read saved provider for the selected scope
(project absent inherits user), not an active session/CLI/project override of a user
preference. Enabled-model and per-model-thinking keys suggest qualified provider/model
IDs; provider forms suggest model IDs, overrides, API types and fallback references.
Add provider opens its name picker before the full form. Typing filters local choices,
Up/Down selects, Enter completes, and Tab or an explicit custom-value action retains
free text and patterns. Existing unknown values remain selectable. Numeric controls
and fixed enum choices remain unchanged. Sensitive frames never invoke suggestion
callbacks; metadata preparation is bounded and late results are navigation/lifecycle
guarded. No auth checks, host registry refresh, provider requests, credential
resolution, or model calls populate these lists. Saved definitions update UI metadata
without claiming runtime activation or live endpoint availability.

Enter-to-edit, wrap/clamp behavior, and Escape precedence are planning defaults resolving minor unspecified interaction details. Global search and no undo are user-confirmed decisions. No persistent configuration undo feature is added; cancelling an uncommitted editor is not undoing a saved change.

Alternative: Left/Right changes values, as in some stock lists. Rejected because it contradicts the requested tab navigation. Alternative: filtering only the current tab. Rejected by the user in favor of all-tab search.

### 4. Safe scoped persistence without pretending to own host runtime state

Resolve agent configuration with public `getAgentDir()`, not a hardcoded home path. Resolve project files from command context cwd and host trust. Do not create directories/files on read or factory load. Use plain file inspection and local validators; creating ModelRegistry or connecting MCP merely to inspect configuration could evaluate credentials and is excluded.

For built-in backends, use a per-path async mutation queue and a shared transactional writer:
1. Validate the proposed complete entry locally.
2. Acquire the conventional path lock; for settings.json match host `proper-lockfile` behavior (`realpath: false`). Add this as an explicit runtime dependency rather than deep-importing a private storage class.
3. Re-read and parse under the lock. Compare the target entry with the editor's baseline revision; reject same-entry conflicts. Retain unrelated updates from the current file.
4. Apply the smallest semantic patch, preserving unknown keys and unchanged secret-bearing values. Validate the resulting subsystem configuration. Treat renames as one entry transaction, rejecting destination collisions.
5. Write a same-directory temporary file with appropriate permissions, replace atomically, clean up, and release the lock. Do not overwrite malformed files or fall back to truncating writes after a replacement failure.
6. Return persisted acknowledgement and refresh provenance/effective information.

Use tested subsystem-specific merge behavior, including native nested merges, special resource arrays, and named MCP replacement. A locally created SettingsManager can be a read/merge reference if it does not introduce side effects, but is never considered the active host manager. Activation policy is explicit: theme can use the public UI operation; runtime model/thinking/tool changes are separate actions rather than side effects of editing startup defaults. Other edits conservatively require reload or restart based on a baseline activation matrix. Runtime application failure after a successful save is reported as saved-but-not-active, not a fictitious persistence failure.

Alternative: instantiate a SettingsManager and call any available setters. Rejected as a generic solution: not all fields/scopes have setters and the new instance cannot guarantee host activation. Alternative: whole-file write from an old snapshot. Rejected due to unrelated-update loss.

### 5. Baseline completeness and scoped structured editors

Native catalog groups settings by purpose while retaining exact storage paths and accepted union types. Support additions/removals of map entries and resource/package objects, not just toggles. Reset removes only the selected override.

Keybindings: use the injected host keybindings manager's effective configuration/public methods as the runtime source and a baseline action metadata catalog reconciled with Pi 0.99.1 declarations. Preserve user overrides of unknown future actions. Validate key syntax with public pi-tui support; display conflict warnings with contextual overlap caveats. The installed 0.99.1 host documents/types `+` and captures `+`/`ctrl++`, but its matcher rejects them. The user-selected compatibility policy is to reject new plus-key assignments with an explicit host-version explanation while preserving existing assignments; do not patch Pi core or claim they activate successfully. User scope only; indicate reload requirement.

MCP: edit `mcpServers` and supported root options such as autoEnableCodemode. Complete editors cover command/args/env/cwd versus URL/headers/OAuth, optional type, enabled, exposure, toolExposure and timeout. Do not access mcp-auth.json or launch/resolve credentials. User/project support follows trust and server-name replacement. Reload reconnects through the host; the center does not become an MCP client.

Models: edit agent-directory `models.json` providers, models, and modelOverrides, including baseline optional metadata and compatibility fields. Use reviewed local schemas matching host validation rather than a single generic provider form. Do not access auth.json or execute `!command`. Saved defaults and active session model remain distinct. Refresh via supported model catalog reload operations only when explicit and safe; otherwise show the activation matrix's reload requirement.

Unknown keys are retained but not advertised as automatically supported settings. The package targets baseline Pi 0.99.1 with declared compatible peer range; future support requires catalog/validation updates and coverage tests, not a claim to know every future setting.

### 6. Versioned event-bus registration with a lightweight helper

Use channels `pi-settings:v1:request`, `pi-settings:v1:register`, and `pi-settings:v1:unregister` on `pi.events`. A registration includes protocolVersion, extensionId, an owner token, displayName, sections/pages, typed descriptors, and callback operations. The optional helper emits at registration time, subscribes to discovery requests, re-emits idempotently, and returns cleanup. It performs no storage work and has no dependency on a listener being present. Document the raw protocol for consumers that do not depend on this package.

The center subscribes before requesting providers, requests at runtime startup and each interaction opening, and validates shape/version/unique IDs before accepting. Same owner/id can refresh descriptors; different owner with the same extensionId is rejected, not silently replaced. Registry updates re-index global search. Withdrawal removes rows and cancels incomplete editing; saves already dispatched are tracked until a bounded outcome arrives. Reload/shutdown clears listeners and owner records.

Plugin callbacks own persistence and supported scope. Document promise-based reads/validation/writes and a result distinguishing persisted value/revision from activation status. Use a documented 10-second operation deadline and cooperative AbortSignal; a timeout yields an indeterminate write state that requires read-back before retry, since trusted callbacks may ignore cancellation and finish late. Do not claim rollback on timeout. Isolate diagnostics and reject new stale writes after withdrawal.

Alternative: sniff files, source code, or arbitrary extension metadata. Rejected because Pi exposes no universal extension settings schema and the user selected registration-only initial coverage.

### 7. Secrets, trust, and package compatibility

Index descriptor metadata only. Mask credentials and sensitive headers/environment values; allow deliberate replacement while distinguishing unchanged masked fields from empty input. Credential expressions remain literal expressions, never executed by UI validation. Sanitize errors before rendering/logging, including backend and plugin errors. Do not store full secret-bearing snapshots in diagnostics or test snapshots. In-process extensions are trusted code; protocol validation is not a security sandbox.

Declare pi-tui as a direct host peer if imported. Additional normal runtime dependencies, such as proper-lockfile, are declared locally and must work with published raw TypeScript loading. Keep the root extension export stable and add the registration subpath to the publish allowlist through src. Update manifest tests to distinguish node: built-ins, declared runtime dependencies, and host peers rather than treating every import as a peer. Pin supported host expectations to the baseline rather than retain an untested `*` promise. Preserve independent loading and umbrella composition; do not introduce a standalone-to-umbrella dependency.

## Risks / Trade-offs

- [Schema drift] -> Baseline coverage fixtures and conformance cases; preserve unknown fields and document supported host versions.
- [Saved configuration differs from active host state] -> Explicit activation matrix and distinct saved/effective displays; no access to private live manager internals.
- [Non-cooperating external writers ignore locks] -> Re-read, entry revision checks, atomic replacement; document that lock-ignoring simultaneous writes cannot be guaranteed conflict-free.
- [Windows replacement/permission failures] -> Cross-platform temporary-file/locking tests and fail safely without truncation fallback.
- [Plugin callbacks throw, hang, or finish after timeout] -> Bounded operations, cancellation signal, indeterminate-write read-back, stale-result guards, and isolated diagnostics.
- [Large global catalog] -> Metadata-only cached index, invalidation on registration changes, bounded visible result rendering; no config file reads per keystroke.
- [Full-screen overlay over terminal images] -> Manual coverage check against image-bearing transcripts in both renderer modes; document or fix verified limitations without adding a second renderer.
- [Secret disclosure] -> Central redaction and masked-field persistence tests; no evaluation/probing in browse or validation paths.
- [No undo] -> Validated per-entry completion, safe cancellation before completion, visible errors, and explicit deletion confirmation; no hidden rollback/history feature.

## Migration Plan

No initial data migration is required: use existing host configuration locations and formats. Replace scaffold tests with behavior tests and update package documentation from inert scaffold to supported functionality. Introduce protocol version 1 and the registration subpath without changing the root entrypoint. Test standalone and umbrella loading independently. Existing unregistered plugins remain unchanged and unavailable in Extensions until they participate.

Rollback means unloading pi-settings or reverting its package version; saved files remain valid host configuration and are not automatically reverted. Users can continue using Pi's native commands or edit configuration directly. Do not create backups or a configuration undo system as an implicit rollback mechanism.
