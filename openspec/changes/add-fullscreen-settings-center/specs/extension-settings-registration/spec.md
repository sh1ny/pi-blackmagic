# Spec Delta

## Purpose

Let extensions opt into the unified settings center through a versioned contract while retaining ownership of validation, persistence, scope, and activation behavior.

## ADDED Requirements

### Requirement: Versioned opt-in settings registration
The package SHALL publish a documented, versioned registration contract with a stable extension identity, display metadata, specialized pages/sections, setting descriptors, supported scopes, and read/validate/write operations. Descriptors SHALL support booleans, choices, text, numbers, lists, and structured entries, including sensitivity and activation metadata. Registration MUST NOT require importing the settings extension entrypoint or installing it as a runtime dependency merely to emit compatible registrations.

#### Scenario: Register a specialized extension page
- **WHEN** a participating extension supplies valid registration metadata and settings operations
- **THEN** its specialized pages are available under Extensions and its non-secret descriptors appear in global search

### Requirement: Load-order-independent discovery
Participating extensions SHALL be able to announce registrations and answer a settings-catalog discovery request. The center SHALL request registrations when its runtime starts and when a settings interaction opens, accept announcements from later-loading extensions, and treat repeated registration of the same identity by the same owner idempotently. A registration helper SHALL let an extension continue normally when pi-settings is absent.

#### Scenario: Provider loads first
- **WHEN** a participating extension loads before the settings center
- **THEN** the center's later discovery request obtains its descriptors and operations

#### Scenario: Center loads first
- **WHEN** a participating extension loads after the settings center
- **THEN** its announcement adds its pages without restarting Pi

#### Scenario: Settings center absent
- **WHEN** a participating extension runs without pi-settings installed
- **THEN** registration produces no missing-consumer failure and the extension's ordinary behavior continues

### Requirement: Plugin-owned persistence and activation
The settings center SHALL invoke the registered extension's operations to read, validate, save, and remove overrides only in declared supported scopes. It MUST NOT infer plugin file locations or mutate plugin storage itself. A completed edit SHALL be considered saved only after plugin acknowledgement, and the plugin's reported activation requirement SHALL be displayed without automatic reload.

#### Scenario: Plugin autosave success
- **WHEN** an extension accepts a completed valid edit and acknowledges persistence
- **THEN** the center displays the acknowledged value and plugin-reported activation status

#### Scenario: Plugin rejects edit
- **WHEN** plugin validation or persistence rejects an edit
- **THEN** the center reports a sanitized error and does not present the rejected value as persisted

### Requirement: Registration validation and isolation
The center SHALL reject unsupported protocol versions, malformed descriptors, duplicate setting identities within a registration, and conflicting ownership of extension identities. Invalid registration and failing or nonresponsive plugin operations SHALL produce bounded, safe diagnostics without disabling other configuration pages. Public contract validation MUST NOT be represented as sandboxing trusted in-process extension code.

#### Scenario: Unsupported protocol
- **WHEN** an extension registers an unsupported protocol version
- **THEN** its settings are unavailable with a compatibility diagnostic and other settings remain usable

#### Scenario: Failed plugin operation
- **WHEN** one extension's read operation throws or exceeds the documented timeout
- **THEN** its page shows an error while native settings and other registered extensions remain usable

### Requirement: Registration lifecycle cleanup
Registrations SHALL be scoped to the active extension runtime, support explicit withdrawal, and release listeners during shutdown or reload. Withdrawal SHALL remove entries from pages and search, cancel incomplete editors for removed entries, and prevent new writes through stale callbacks; in-flight saves SHALL be settled and their outcome reported.

#### Scenario: Withdraw selected entry
- **WHEN** a plugin withdraws while one of its settings is selected or being edited
- **THEN** the stale entry disappears, incomplete editing is cancelled without a new write, and selection moves to an available entry

#### Scenario: Reload runtime
- **WHEN** extensions reload
- **THEN** the old catalog and listeners are discarded and the fresh runtime rediscovers registrations without duplicated pages

### Requirement: Registration-only initial compatibility
The initial release SHALL expose third-party settings only through explicit participation in the registration contract. It MUST NOT scan arbitrary plugin files, parse source to infer settings, or claim support for unregistered extensions. No legacy compatibility adapters SHALL ship in this change.

#### Scenario: No registered extensions
- **WHEN** the Extensions tab has no participating providers
- **THEN** it shows an explanatory empty state and registration guidance without implying that every installed plugin's configuration is available
