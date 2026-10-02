# Proposal

## Why

Pi's built-in settings UI exposes only common preferences, while keybindings, MCP servers, custom providers/models, and extension configuration are spread across separate files and commands. The inert pi-settings scaffold can become a unified, full-screen configuration center with immediate, validated saving and predictable keyboard navigation.

## What Changes

- Replace the no-op pi-settings behavior with an independently loadable full-screen settings center, visually inspired by OMP, that covers the visible Pi viewport and returns to the agent when closed.
- Cover every user-configurable native setting supported by the baseline Pi 0.99.1 settings reference and schema, including structured values, resource lists, scope restrictions, and inherited values.
- Add dedicated configuration pages for all named keybinding actions, MCP server definitions, and custom providers/models and model overrides, using each subsystem's supported scope and validation rules.
- Navigate top-level tabs with Left/Right and settings within the active page with Up/Down. Printable typing starts global search across all tabs and registered extension pages immediately outside value editors; there is no separate search activation shortcut.
- Autosave every completed, valid edit; show failures and activation requirements. Do not add a global Save/Apply workflow, configuration undo, or automatic reload/restart.
- Publish a versioned settings-registration interface so participating extensions contribute specialized pages, typed descriptors, and plugin-owned read/validate/write callbacks. Support either extension load order and absence of pi-settings.
- Preserve unrelated configuration, respect project trust and inheritance, and protect secret-bearing fields from search, diagnostics, and incidental display.
- Initial third-party coverage is registration only: legacy adapters and inferred settings discovery are explicitly deferred.

## Capabilities

### New Capabilities

- `settings-center-ui`: Full-viewport presentation, keyboard navigation, implicit search, edit completion, and save/activation feedback.
- `pi-configuration-management`: Complete baseline native configuration coverage, keybindings, MCP and model/provider editors, safe scoped persistence, and activation semantics.
- `extension-settings-registration`: Versioned opt-in registration, specialized extension pages, descriptor validation, lifecycle behavior, and plugin-owned persistence.

### Modified Capabilities

None. The current OpenSpec capability inventory is empty.

## Impact

- Primarily affects `packages/pi-settings/src`, its package exports and host peer declarations, tests, and README; the umbrella package must continue loading the same extension exactly once.
- Replaces the existing no-op extension test and updates manifest tests that currently enforce a single entrypoint and no additional host imports.
- Uses the Pi extension API, event bus, and pi-tui custom overlay components. New direct host-library imports must be explicitly declared as peers, not silently assumed transitive dependencies.
- Reads and edits supported Pi configuration at runtime: agent-directory settings.json, keybindings.json, mcp.json, models.json, and trusted project .pi/settings.json and .pi/mcp.json. No project-level keybindings/models files are invented.
- Introduces a public registration contract for extension authors, without requiring their code to import the extension entrypoint or making configuration changes depend on a running model call.
- No changes to Pi core, credential stores, third-party extension implementations, or project code occur as part of this planning workflow.
