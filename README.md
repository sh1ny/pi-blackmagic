# Pi Blackmagic

**Enhances your Pi....almost like black magic**

A collection of extensions for the Pi coding agent, starting with a searchable settings center that brings preferences, keybindings, MCP servers, and model configuration into one terminal UI.

[Explore the settings center](packages/pi-settings/README.md) · [Try it locally](#getting-started) · [Documentation](#documentation)

<!-- Add a real settings-center screenshot or short demo here when one is available. -->

## Make Pi your own

Pi's configuration spans several files and commands. Pi Blackmagic's first extension, **pi-settings**, lets you browse and edit those settings without leaving the agent or remembering which file holds each option.

Open `/pi-settings` for a full-viewport, keyboard-driven overlay. Search across every page, edit a value with a typed control, and see whether the saved change needs a reload or restart. Pi's built-in `/settings` remains available.

The extensions are designed to work independently, with a thin suite package for loading them together. Today, the suite contains pi-settings; this is an early, unpublished implementation, not a released collection of finished extensions.

## A settings center beyond the basics

### Find the setting, not the file

Browse General, Appearance, Models, Context, Tools, Keybindings, MCP, and Extensions. Start typing to search across all pages, including settings that have not yet been added to your configuration files. Results show their source, and selected entries explain what they control.

The catalog is reviewed against **Pi 0.99.1**. Unknown future fields are preserved when editing, but are not guessed into new controls or treated as automatically supported.

### Tune how your agent works

Adjust native preferences such as appearance, context compaction, thinking budgets, tool defaults, and resource/package declarations. Lists, maps, and nested settings have typed editors rather than requiring you to rewrite a JSON file.

Where supported, switch between user settings and trusted-project overrides. See configured and inherited values, then remove an override to return to the inherited setting without deleting neighboring fields.

### Put shortcuts under your fingers

Record a keybinding, assign several keys to an action, disable an action, or restore its defaults. Potential shared-key conflicts produce a warning before saving, since the same key can legitimately serve different terminal contexts.

Keybindings are user-only and require an explicit reload. Pi 0.99.1 cannot match new `+`/`ctrl++` assignments; the center rejects those assignments with a compatibility explanation while retaining existing stored values.

### Configure MCP and models in one place

Create, edit, rename, and delete MCP server definitions using structured stdio or HTTP forms. Manage transport options, environment/header values, OAuth configuration, and tool exposure without launching a server just to edit its configuration.

On the Models page, edit providers, model definitions, and overrides. Search local provider/model suggestions or enter custom IDs and patterns. Suggestions come from existing local metadata, not endpoint probes or authentication checks; choosing a startup default does not switch the current session's model.

MCP supports user and trusted-project configuration; a same-named project server replaces the user definition rather than merging with it. Provider/model definitions are user-only. Saved MCP and provider/model changes require an explicit reload.

### Bring participating extensions along

Extensions can register their own settings pages through a versioned, opt-in interface while keeping control of their storage and validation. Their settings join the same global search and editing workflow.

This is registration-based integration, not automatic discovery of every installed extension. The [registration guide](packages/pi-settings/docs/registration.md) includes both a raw event protocol and an optional typed helper.

## Know what changed

- **One completed entry, one save.** Valid edits autosave individually. Structured forms save only when you complete the entry; cancelling unfinished input does not write a partial form.
- **Saved is not always active.** The center distinguishes a saved change from an active one and reports reload/restart requirements or activation failures. It never reloads or restarts Pi automatically.
- **Respect existing configuration.** Writes preserve unrelated and unknown fields, retain unrelated external edits, and reject detected changes to the entry you were editing. Malformed files are reported rather than replaced with defaults.
- **Keep credentials out of ordinary displays.** Sensitive values are masked and excluded from search. The built-in editors leave credential expressions literal and do not edit `auth.json` or `mcp-auth.json`.
- **Respect project trust.** Untrusted project configuration is neither read nor written. Unsupported project scopes are explained, never silently redirected to user settings.

There is no global Save/Apply or configuration undo. Escape cancels unfinished input, not earlier saved edits. Locking and atomic replacement protect this writer's transactions, but cannot guarantee conflict-free writes from external tools that ignore the locking convention. Registered extensions remain trusted, in-process code, not sandboxed plugins.

## From search to saved

**Open → Find → Edit → Complete → Check activation**

1. Run `/pi-settings` in an interactive Pi session.
2. Use Left/Right to change tabs and Up/Down to select a setting, or start typing to search globally.
3. Press Enter to edit. Use Tab from the settings list for scope, reset, and delete actions.
4. Confirm a scalar edit with Enter, or choose **Complete entry** in a structured form. Known boolean values toggle and save on activation.
5. Read the save outcome, then explicitly reload or restart if required. Escape cancels an unfinished editor, clears search, or closes the panel in that order.

Typical uses include tuning compaction for a project, restoring a shortcut after experimenting, preparing a disabled MCP server definition, and adding a custom provider without evaluating its credential command.

## Current status

The settings UI, configuration backends, and extension registration protocol are implemented and covered by automated tests. The project is **under active development and acceptance testing**; the [acceptance checklist](openspec/changes/add-fullscreen-settings-center/tasks.md) is not complete. Test coverage is not a claim that every real-host interaction has been accepted.

The implementation targets Pi 0.99.1. Local verification is on Windows; Linux execution and cross-platform CI coverage are not yet established, and no CI workflow is included. Broader host-version compatibility is not claimed.

Packages are unpublished candidates. npm names/scope ownership, license selection, release artifact inspection, and remaining host acceptance checks are release gates. Some package/layout documentation still describes the earlier no-op foundation; the settings-center documentation reflects the newer implementation.

## Getting started

Try the settings center from this checkout before using it with your normal configuration. Prerequisites: **mise**, **Pi 0.99.1** available as `pi` on PATH, and **Nushell** available as `nu`.

From the repository root:

```sh
mise trust
mise install
mise run setup
nu packages/pi-settings/start.nu
```

Open `/pi-settings` after Pi starts. The launcher defaults to fullscreen, offline operation, an in-memory session, and a fresh **temporary user configuration directory**. It disables discovered resources and leaves the project untrusted. Test edits stay in that temporary directory, which is printed and retained for inspection.

For regular terminal mode, live configuration, or a direct Pi invocation, see [local use and verification](packages/pi-settings/README.md#local-use-and-verification). **`--live` and direct/development launch commands use your normal user configuration: completed edits change those files.** Load either the suite or its standalone member, never both in the same session.

mise pins Bun 1.4.2 and Node 24.21.0 without changing global defaults. Setup installs dependencies from `bun.lock`; it does not install or update Pi or Nushell. There is no published npm installation path yet.

## Documentation

| Guide | What you will find |
| --- | --- |
| [Settings center](packages/pi-settings/README.md) | Configuration locations, scopes, inheritance, autosave, safety limitations, and launch options |
| [Navigation and editors](packages/pi-settings/docs/navigation.md) | Detailed keyboard behavior and controller/editor integration |
| [MCP configuration](packages/pi-settings/docs/mcp.md) | Transport fields, server replacement rules, credentials, and reload requirements |
| [Providers and models](packages/pi-settings/docs/models.md) | Catalog choices, model definitions, overrides, and compatibility fields |
| [Extension registration](packages/pi-settings/docs/registration.md) | Protocol, examples, ownership, lifecycle, and operation deadlines |
| [Workspace layout decision](docs/decisions/0001-monorepo-layout.md) | Original package boundaries and distribution rationale |

## Development and technical overview

The private Bun workspace contains `packages/pi-settings` and the `packages/blackmagic` suite. Extensions ship raw TypeScript and run inside Pi; Bun is the dependency manager and test runner, not the extension runtime. Pi supplies the host API and terminal UI libraries as peers. The suite composes its members without requiring them to depend on it.

<details>
<summary>Workspace commands and verification boundaries</summary>

| Command | Purpose |
| --- | --- |
| `mise run setup` | Install locked workspace dependencies |
| `mise run fmt:check` | Check formatting without writes |
| `mise run fmt:fix` | Explicitly apply formatting fixes |
| `mise run lint` | Check lint without writes |
| `mise run typecheck` | Check strict TypeScript without emitting files |
| `mise run test` | Run credential-free tests with synthetic/temporary configuration |
| `mise run check` | Run formatting, lint, type checks, and tests concurrently |
| `mise run dev:pi-settings` | Launch only the standalone extension with normal configuration |
| `mise run dev:suite` | Launch only the suite entrypoint with normal configuration |

Development launchers invoke Pi itself with `--no-extensions --extension <absolute-entrypoint>` to avoid co-loading discovered extensions. Extra arguments can be forwarded, for example `mise run dev:pi-settings -- --name settings-dev`.

Normal checks do not invoke models, require credentials, or spend model quota. Real-host smoke tests are separate; live model tests require explicit opt-in and are not part of `check`. Checks are scoped to workspace tooling/source and do not rewrite agent metadata or OpenSpec documents.

Each member owns its source, tests, documentation, and dependencies. Published contents are controlled by Pi manifests and allowlists; `.pi/`, `.omp/`, and OpenSpec planning files are development resources, not distributed extension resources. Before release, inspect packed contents and workspace dependency conversion, and verify loading inside Pi separately from Bun tests.

</details>

## Contributing

Start with the [settings-center documentation](packages/pi-settings/README.md) and [active change checklist](openspec/changes/add-fullscreen-settings-center/tasks.md). Run `mise run check` before submitting changes; use temporary configuration and synthetic credentials for tests. Keep distributed extensions free of Bun-only APIs, and commit `bun.lock` whenever dependencies deliberately change. Root development dependencies are pinned to exact versions.

## License

No license has been assigned, and the repository contains no license file. License selection is required before publication.
