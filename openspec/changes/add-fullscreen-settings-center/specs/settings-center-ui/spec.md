# Spec Delta

## Purpose

Provide a full-screen, keyboard-driven configuration center with immediate global search, automatic saving, and clear feedback without a separate apply or undo workflow.

## ADDED Requirements

### Requirement: Full-viewport settings interaction
The extension SHALL expose a dedicated settings-center command in interactive terminal mode without taking over Pi's built-in settings command. The center MUST cover the entire visible terminal viewport, including otherwise empty rows, adapt to terminal resizing, and restore the underlying agent interface and input focus when closed. It SHALL NOT change the host renderer mode merely to open settings.

#### Scenario: Open and close over the agent
- **WHEN** the user opens the center in regular or fullscreen terminal mode and subsequently closes it
- **THEN** the visible agent interface is covered while the center is open and the underlying interface and editor focus return after closure

#### Scenario: Terminal resize
- **WHEN** the terminal becomes narrower or shorter while settings are open
- **THEN** the center fits the new viewport without line-width overflow and keeps the selected entry reachable through scrolling

#### Scenario: Non-terminal invocation
- **WHEN** the command is invoked without an interactive terminal UI
- **THEN** it reports that the settings center requires interactive mode without attempting custom rendering or modifying configuration

### Requirement: Arrow-key navigation
In browsing mode, Left and Right SHALL switch top-level tabs, and Up and Down SHALL move selection through the displayed settings or search results. Left and Right MUST NOT mutate a selected setting. The center SHALL keep selection visible and show the selected setting's description and supported scope.

#### Scenario: Browse settings
- **WHEN** the user presses Right followed by Down outside an editor
- **THEN** the active top-level tab changes and selection moves down its settings without changing any value

#### Scenario: Scroll a long page
- **WHEN** selection moves beyond the currently displayed rows
- **THEN** the page scrolls to keep the selected setting visible

### Requirement: Immediate global type-to-search
Outside value editors, printable typing SHALL immediately filter a global catalog containing native configuration and registered extension settings. Search SHALL match non-secret labels, identifiers, descriptions, and source names, label results with their source tab/page, and support Up/Down selection and editing of a matching result. Backspace SHALL update the query; no explicit search activation is required. Left/Right SHALL remain tab navigation while a query is present and MUST NOT silently restrict results to that tab.

#### Scenario: Search another tab and extension
- **WHEN** the user types a query while browsing a native tab
- **THEN** matching entries from other native tabs and registered extension pages appear immediately with source labels

#### Scenario: Tab navigation while searching
- **WHEN** the user presses Left or Right with a nonempty query
- **THEN** the highlighted tab changes while the query and global search scope remain intact

#### Scenario: No matches
- **WHEN** no catalog entry matches the query
- **THEN** an explicit empty-result state appears without selecting or editing a stale entry

### Requirement: Explicit edit completion within autosave
Enter SHALL activate the selected entry. Toggles SHALL save upon activation; choice selection, text/number confirmation, keybinding recording confirmation, and completion of a structured entry SHALL save automatically when valid. Printable input and arrow keys inside an editor SHALL belong to that editor rather than background search or tab navigation. Escape SHALL cancel an incomplete editor without saving, clear a nonempty search query when browsing, and otherwise close the center.

#### Scenario: Text editing does not search
- **WHEN** a text-value editor is active and the user types and confirms a valid value
- **THEN** the text edits that value, the search query is unchanged, and the completed edit saves automatically

#### Scenario: Cancel incomplete structured input
- **WHEN** the user cancels an incomplete MCP-server editor
- **THEN** no partially completed server configuration is persisted

### Requirement: Local provider and model choices
The Models page SHALL offer searchable local provider/model choices for startup defaults, enabled-model list items, per-model thinking keys, Add/rename provider, and model/API/override/fallback identifiers inside provider forms. Default model choices SHALL follow the saved provider in the selected supported scope and its saved inheritance, not implicitly select or depend on the current session model. Suggestions MUST preserve schema-valid custom IDs, model patterns, and existing unlisted values through an explicit typed fallback. Sensitive fields MUST NOT become suggestion data. Populating choices MUST NOT perform authentication checks, resolve credentials, refresh the host model runtime, query providers, or make model calls. Numeric controls and fixed enum choices SHALL remain type-appropriate.

#### Scenario: Choose startup provider and model
- **WHEN** the user edits the default provider or model
- **THEN** a searchable local catalog offers readable provider/model names and IDs, model choices follow the saved provider for that scope, and confirming changes only the intended startup preference

#### Scenario: Choose a provider for a complete definition
- **WHEN** the user activates Add provider
- **THEN** provider choices appear first and completing the choice returns to the provider form without persisting a partial definition

#### Scenario: Custom model or enabled-model pattern
- **WHEN** a needed ID or pattern is not in the local catalog
- **THEN** the user can enter a schema-valid custom value or retain an existing unlisted value without the catalog becoming a validation restriction

#### Scenario: Saved definitions and missing catalog metadata
- **WHEN** a provider/model definition is saved or local host metadata is unavailable
- **THEN** newly saved public definition metadata becomes selectable without an automatic runtime reload, or custom editing remains available, without resolving credentials or claiming endpoint availability

### Requirement: Save and activation feedback without undo
The center SHALL display saving, saved, validation failure, persistence failure, and applicable reload/restart-required status. It MUST NOT claim persistence success before the backend acknowledges it or equate saved state with active runtime state. It SHALL provide no configuration undo action and no global Save or Apply action, and SHALL NOT reload or restart Pi automatically.

#### Scenario: Successful edit needing activation
- **WHEN** a completed edit saves but cannot become active immediately
- **THEN** the center reports saved state and the required explicit reload or restart without performing it

#### Scenario: Failed save
- **WHEN** persistence rejects an edit
- **THEN** the center shows a safe error and retains the last confirmed persisted value rather than presenting the edit as saved

### Requirement: Safe closure during pending saves
The center SHALL track outstanding saves and settle them before completing normal closure. A pending or failed save MUST NOT disappear as an unreported success, and saved earlier edits MUST NOT be rolled back when an incomplete editor is cancelled.

#### Scenario: Close during autosave
- **WHEN** the user attempts to close while a completed edit is still saving
- **THEN** closure waits for the result and any failure remains visible before the user can finish closing
