# Tasks

## 1. Catalog and package foundations

- [x] 1.1 Add typed descriptor, scoped read result, edit transaction, revision, sensitivity, and activation-result contracts under packages/pi-settings/src; verify Bun unit tests cover scalar, union, list, map, and structured-entry descriptors and TypeScript checking passes.
- [x] 1.2 Add a reviewed Pi 0.99.1 coverage inventory for all user-configurable native paths, keybinding actions, MCP fields, and models/provider fields, excluding documented host-maintained fields; verify coverage tests identify any omitted path and preserve fixtures for unknown future fields.
- [x] 1.3 Define native page grouping and metadata-only global search indexing; verify tests include absent/default-valued settings, nested overrides, source labels, case-insensitive queries, empty results, and exclusion of values and sensitive metadata.
- [x] 1.4 Declare directly imported host peers and normal runtime locking dependencies, select the documented baseline-compatible host range, and revise manifest tests to distinguish node built-ins, dependencies, and peers; verify package export/import allowlist tests and typecheck pass.
- [x] 1.5 Document baseline completeness, excluded bookkeeping fields, supported scopes, and proposed /pi-settings entrypoint in the package README; verify documentation matches the coverage fixture and does not claim automatic compatibility with future host fields.

## 2. Shared persistence, trust, and redaction

- [x] 2.1 Implement configuration path resolution using getAgentDir and command cwd, with trusted-project checks and no filesystem creation on reads; verify temporary-directory tests cover custom agent directories, missing files, and blocked untrusted project access.
- [x] 2.2 Implement per-path mutation queues and proper-lockfile-compatible settings locks with bounded acquisition and cleanup; verify concurrent edit tests serialize writes and contend correctly with the baseline host locking convention.
- [x] 2.3 Implement entry-revision checking, semantic patches, same-directory temporary writes and atomic replacement preserving unrelated keys and permissions; verify tests cover unrelated external edits, same-entry conflicts, renames, destination collisions, malformed JSON, failed writes, and temporary-file cleanup.
- [x] 2.4 Implement masked-field handling and safe diagnostics without credential resolution; verify synthetic-secret tests prove unchanged sensitive values survive edits and never enter logs, errors, ordinary display strings, or search indexes.
- [x] 2.5 Document persistence conflict handling, malformed-file behavior, trust restrictions, and limitations for non-locking external writers; verify examples align with persistence tests and contain no real credentials.

## 3. Native Pi settings backend

- [x] 3.1 Implement user/project native settings reads, baseline defaults, provenance, host-override distinctions, and native nested/resource merge semantics; verify conformance tests against baseline host behavior include global-only options, nested overrides, resource additions/exclusions, and unavailable project scope.
- [x] 3.2 Implement typed validation and autosave transactions for all native scalar/union settings; verify table-driven tests exercise every descriptor's valid and invalid values without touching personal configuration.
- [x] 3.3 Implement list/map/package and per-model structured editing transactions plus remove-override operations; verify tests cover thinking budgets, compaction model overrides, resource object declarations, partial-entry cancellation, and restoration of inherited values.
- [x] 3.4 Add a per-setting activation matrix and supported immediate theme application without treating a separate SettingsManager as the active host manager; verify mocked-host tests distinguish successful persistence, runtime application failure, reload requirement, restart requirement, and unchanged session model defaults.
- [x] 3.5 Document native scope/inheritance, reset behavior, and saved-versus-active semantics in README; verify the documented activation examples correspond to matrix tests.

## 4. Keybindings backend

- [x] 4.1 Implement the full baseline action catalog, effective host assignments, and user-only overrides; verify coverage tests reconcile the catalog with baseline declarations and preserve unknown configured actions.
- [x] 4.2 Implement key capture/text validation, single and multiple assignments, empty-list disabling, override removal, and contextual conflict warnings; verify Bun tests cover supported key syntax, invalid keys, platform differences, default restoration, and legitimate shared-key contexts.
- [x] 4.3 Implement keybinding persistence and reload-status feedback using the common writer; verify temporary-file round trips preserve unrelated assignments and documentation explains user-only scope and explicit reload.

## 5. MCP configuration backend

- [x] 5.1 Implement local MCP schema validation, user/trusted-project reads, named-entry replacement, and supported root options; verify schema-coverage and trust tests include autoEnableCodemode and prove no connections or processes run while reading or validating.
- [x] 5.2 Implement complete stdio/HTTP server forms covering command/args/env/cwd, URL/headers/OAuth, optional type, enabled, exposure, toolExposure, and timeout; verify valid/invalid fixture tests cover unsupported SSE, server names, credential expressions, and cross-field constraints.
- [x] 5.3 Implement create/edit/rename/delete server transactions and reload activation feedback; verify complete-entry autosave, cancellation, collision, scope replacement, secret preservation, and unrelated-server persistence tests.
- [x] 5.4 Document MCP editor scope, server replacement rules, literal credential references, and explicit host reload; verify examples are valid synthetic definitions and do not imply that settings-center browsing connects servers or edits mcp-auth.json.

## 6. Provider and model configuration backend

- [ ] 6.1 Implement reviewed local models/provider validation matching all baseline accepted schema fields, without constructing a credential-resolving runtime solely for validation; verify schema conformance cases cover provider definitions, model definitions, overrides, optional metadata, and supported compatibility fields.
- [ ] 6.2 Implement user-only provider/model/override reads and coherent create/edit/rename/delete transactions; verify temporary-file round trips preserve unknown fields, unrelated providers, and untouched sensitive values.
- [ ] 6.3 Integrate configured-versus-session distinctions and safe activation feedback; verify tests prove startup default edits do not select a current-session model and credential commands/endpoints are never evaluated by editing or validation.
- [ ] 6.4 Document provider/model scope, supported fields, credential masking/reference behavior, and activation requirements; verify README examples match schema fixtures and explicitly exclude auth.json management.

## 7. Extension registration protocol

- [ ] 7.1 Implement version 1 event payloads and side-effect-free ./registration export with an optional helper; verify manifest/publish tests include the export and helper tests work with no settings-center consumer or package runtime dependency for raw protocol consumers.
- [ ] 7.2 Implement announce/request rediscovery, owner-aware idempotent registration, withdrawal, and runtime listener cleanup; verify mocked event-bus tests cover both load orders, repeated open, duplicate ownership, replacement by the same owner, reload, and shutdown.
- [ ] 7.3 Validate descriptors and adapt plugin-owned read/validate/write/remove-override callbacks with declared scope and sensitivity handling; verify tests reject malformed versions/IDs, enforce scope support, isolate failing providers, and never infer plugin storage locations.
- [ ] 7.4 Implement documented callback deadlines, cooperative cancellation, indeterminate-write read-back, late-result guards, and in-flight withdrawal behavior; verify fake-timer tests cover thrown callbacks, hanging reads/writes, late success, retries, and no stale new writes.
- [ ] 7.5 Document protocol channels, typed examples, ownership, lifecycle cleanup, operation outcomes, and registration-only initial coverage in package documentation; verify a synthetic fixture extension contributes specialized pages and remains functional with pi-settings absent.

## 8. Full-screen UI and interaction

- [ ] 8.1 Replace inert extension wiring with /pi-settings registration, interactive-mode guarding, fresh full-viewport custom overlays, and idempotent disposal; replace the no-op test with mocked-host behavior tests and verify non-TUI invocation does not render or mutate configuration.
- [x] 8.2 Implement terminal-height rendering, opaque width padding, responsive top tabs, bounded scrolling, selected-item help and status regions; verify render tests cover narrow/short terminals, ANSI/wide characters, theme invalidation, and resize without overflow.
- [x] 8.3 Implement browsing navigation with Left/Right tabs, Up/Down rows, remembered selections, and visible scope/reset actions; verify controller tests prove arrows do not accidentally mutate values and selected rows remain visible.
- [x] 8.4 Implement immediate all-tab search, source-labelled results, Backspace/Escape query handling, and tab navigation that preserves global search scope; verify controller tests include cross-tab and extension matches, dynamic registry updates, empty results, and query clearing back to the active page.
- [x] 8.5 Implement toggle/choice/text/number/list/map/structured editors and keybinding capture with exclusive editor input ownership; verify Enter completion autosaves valid edits, invalid values do not persist, typing inside editors does not search, and Escape cancels only incomplete input.
- [x] 8.6 Integrate saving/acknowledgement/error/activation statuses, deletion confirmation, pending-save closure, and indeterminate plugin outcomes; verify tests cover close during save, rejection acknowledgement, saved-but-not-active display, and absence of global Apply/Save, undo, and automatic reload.
- [x] 8.7 Document keyboard navigation, global search, edit completion, Escape precedence, no undo, and autosave in README; verify the key-hint text and documented interactions agree with controller tests.

- [x] 8.8 Add searchable local provider/model suggestions for Models-page defaults, enabled-model items, per-model thinking keys, Add/rename provider, and provider form model/API/override/fallback references; preserve custom IDs/patterns and masked fields, filter by saved provider/scope, and verify rendering, atomic completion, stale-result guards, and absence of authentication checks, host catalog refresh, network requests, or model calls.

## 9. Integration and acceptance

- [ ] 9.1 Add integration tests composing every backend and a synthetic registered extension through one catalog and UI controller; verify every baseline field is reachable/searchable/editable and scope/sensitivity rules hold without model credentials.
- [ ] 9.2 Verify standalone and umbrella loading independently, with factory-time side effects limited to registration and listeners and no duplicate settings pages; run package and suite tests and ensure no standalone dependency on the umbrella is introduced.
- [ ] 9.3 Run bun test, bun run typecheck, bun run lint, and bun run fmt:check from the workspace; verify all exit successfully and package exports/allowlists include runtime modules but exclude tests and fixtures.
- [ ] 9.4 Manually smoke-test regular and fullscreen host modes with synthetic temporary configuration, long pages, image-bearing transcripts, resize, search, editors, pending saves, closure/focus restoration, and reload-required edits; record the observed results without modifying personal credential stores or making model calls.
- [ ] 9.5 Review the completed implementation against all three delta specs and baseline coverage inventories; verify no undocumented omissions, legacy adapters, inferred plugin discovery, undo, or global apply workflow shipped and resolve acceptance failures before marking the change complete.
