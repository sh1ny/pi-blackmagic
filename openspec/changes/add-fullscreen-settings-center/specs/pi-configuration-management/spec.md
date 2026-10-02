# Spec Delta

## Purpose

Unify management of Pi's supported user configuration across native settings, keybindings, MCP servers, and provider/model definitions while preserving scope, safety, and host compatibility.

## ADDED Requirements

### Requirement: Complete baseline native settings coverage
The center SHALL expose every user-configurable native setting supported by Pi 0.99.1's settings reference and configuration schema, not only settings exposed by the built-in settings picker. Coverage MUST include nested settings, lists, maps, per-model overrides, resource/package declarations, and supported union values, with descriptions, type-appropriate editing, and validation. Host-maintained identity and bookkeeping fields MUST NOT be presented as user preferences. Unknown future fields MUST be preserved rather than silently dropped or inferred as editable preferences.

#### Scenario: Advanced native configuration
- **WHEN** the user opens native configuration pages
- **THEN** advanced entries such as provider retry policy, thinking budgets, compaction model overrides, resource declarations, and terminal capability overrides are available alongside ordinary preferences

#### Scenario: Supported union value
- **WHEN** a setting accepts either an automatic sentinel or a numeric value
- **THEN** both supported forms can be edited and invalid forms are rejected without changing persisted configuration

### Requirement: Correct scope and provenance
For each supported setting the center SHALL display the configured value, effective value where determinable, and source or inheritance. It SHALL support user and trusted project overrides only where Pi supports them, preserve subsystem-specific merge/replacement semantics, and offer removal of an override to return to inheritance. It MUST NOT invent project keybindings or project models configuration.

#### Scenario: Remove a project override
- **WHEN** the user removes a project setting override
- **THEN** only that override is removed and the inherited value and source are displayed

#### Scenario: Global-only native setting
- **WHEN** the user selects a global-only setting such as project trust fallback or HTTP proxy
- **THEN** project-level editing is unavailable and the scope restriction is explained

#### Scenario: Resource combination
- **WHEN** user and project resource lists contain additions or exclusions
- **THEN** the center preserves those expressions and displays their combination consistently with the host rather than applying a generic list replacement rule

### Requirement: Respect project trust
The center MUST NOT read trust-gated project configuration or persist project changes before the host reports the project trusted. An unavailable project scope SHALL be explained without silently redirecting a write to user scope.

#### Scenario: Untrusted project
- **WHEN** settings are opened in an untrusted project
- **THEN** user configuration remains available, trust-gated project configuration is not loaded, and project writes are blocked with an explanation

### Requirement: Complete keybinding management
The center SHALL list every named keybinding action supported by the baseline host and expose user overrides as a single key, multiple keys, or an empty list that disables the action. It SHALL validate key syntax, identify potential conflicts without rejecting legitimate host-context-specific overlap, and allow removal of an override to restore defaults. Saved changes SHALL indicate the host's activation requirement.

#### Scenario: Multiple keys or disabled action
- **WHEN** the user completes a valid multiple-key assignment or an empty assignment
- **THEN** the corresponding user override is saved automatically and the resulting assignments or disabled state are displayed

#### Scenario: Invalid key syntax
- **WHEN** the user confirms a key that the host cannot parse
- **THEN** validation rejects the edit and leaves the previous configuration unchanged

#### Scenario: Baseline plus-key matcher limitation
- **WHEN** the user confirms `+` or a modifier-plus assignment such as `ctrl++` on Pi 0.99.1
- **THEN** validation rejects the edit with an explicit baseline compatibility explanation because the host captures that syntax but cannot match it, existing stored assignments are preserved, and no Pi core patch is applied

### Requirement: Complete MCP configuration management
The center SHALL support creation, editing, renaming, and deletion of configured MCP servers and all supported baseline configuration fields, including stdio and HTTP connection data, environment/header references, OAuth configuration, enablement, exposure, per-tool exposure, timeouts, and top-level configuration options. It SHALL preserve named-server replacement semantics between user and trusted project scopes and validate complete entries before saving. Merely browsing or validating configuration MUST NOT launch server processes, execute credential commands, or initiate network connections.

#### Scenario: Complete stdio entry
- **WHEN** the user finishes a valid server executable, argument list, environment, and working-directory definition
- **THEN** the entire entry saves coherently in the selected supported scope and activation instructions are displayed

#### Scenario: Invalid transport combination
- **WHEN** a server definition has an unsupported transport or invalid combination of connection fields
- **THEN** the edit is rejected without persisting a broken server entry

#### Scenario: Project server override
- **WHEN** a trusted project's server has the same name as a user server
- **THEN** the project entry is shown as replacing the user entry rather than merging its connection fields

### Requirement: Complete provider and model configuration management
The center SHALL support all provider/model configuration fields accepted by the baseline models configuration schema, including provider endpoints, API types, authentication references, headers, model definitions, supported compatibility metadata, and model overrides. It SHALL validate complete provider/model entries, preserve referenced environment variables and commands as expressions, and distinguish configured model metadata and startup defaults from current-session model selection.

#### Scenario: Add compatible provider
- **WHEN** the user completes a valid provider definition with its models
- **THEN** the definition saves automatically in the agent-directory models configuration without probing the endpoint or changing the current session model implicitly

#### Scenario: Model override
- **WHEN** the user edits metadata for an existing model through a model override
- **THEN** the override is preserved without replacing unrelated provider model definitions

### Requirement: Non-destructive persistence
Every completed edit SHALL persist as a validated change to the intended configuration entry. Persistence MUST preserve unrelated and unknown content, detect conflicting edits made since the entry was loaded, avoid truncated files, and report malformed existing configuration without overwriting it. Independent entry edits SHALL be merged where safe; conflicting changes SHALL be rejected for refresh and re-edit. Deleting or renaming an entry SHALL preserve other entries.

#### Scenario: External unrelated edit
- **WHEN** another writer changes an unrelated entry before autosave
- **THEN** the save preserves that external change and applies only the intended edit

#### Scenario: Same-entry conflict
- **WHEN** another writer changes the same entry before autosave
- **THEN** the center reports a conflict rather than overwriting the newer value

#### Scenario: Existing malformed file
- **WHEN** a backing file cannot be parsed
- **THEN** that backend displays an error and does not replace the file with defaults while other healthy backends remain usable

### Requirement: Separate persistence and runtime activation
The center SHALL report saved configuration separately from current-session effective state. Only explicitly supported runtime operations SHALL be used to activate changes immediately; otherwise the UI SHALL state reload or restart requirements. It MUST NOT treat a separately created settings reader as the host's active settings manager.

#### Scenario: Startup model preference
- **WHEN** the user saves a startup model or thinking preference
- **THEN** the preference is persisted without claiming the current session changed unless a separate supported runtime action actually changed it

### Requirement: Secret-safe configuration handling
The center MUST NOT edit Pi credential stores as generic configuration, resolve credential expressions while browsing, or include secret values in search, ordinary previews, logs, or errors. Sensitive fields SHALL be masked by default and editable deliberately without incidental disclosure; untouched masked fields MUST retain their original values. Non-secret configuration and credential references SHALL remain configurable.

#### Scenario: Existing sensitive header
- **WHEN** a configuration entry contains an authorization header and the user edits another field
- **THEN** the header stays masked, is absent from search and diagnostics, and remains unchanged in storage

#### Scenario: Credential command expression
- **WHEN** the center displays or validates an entry using a credential command
- **THEN** it treats the expression as configuration and does not execute the command
