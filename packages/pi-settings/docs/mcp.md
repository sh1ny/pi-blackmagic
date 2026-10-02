# MCP configuration backend

The settings backend targets Pi **0.99.1**. It edits `mcp.json`, not an active MCP connection. Reading, drafting, validating, and saving never launch a server, execute credential commands, resolve environment references, or contact an endpoint. This backend does **not** manage `mcp-auth.json`, OAuth tokens, login/logout, or authentication stores.

## Scope and inheritance

- **User:** `mcp.json` in the agent directory obtained through Pi's `getAgentDir()` (or the backend's injected resolver).
- **Project:** `<command cwd>/.pi/mcp.json`, available only while the host reports the project trusted. Trust is checked again during reads and through the persistence location callback before mutation; revocation does not redirect writes to user scope.
- A project server with the same name **replaces the entire user server**, including connection fields and credentials. It does not recursively merge them.
- `autoEnableCodemode` is a boolean root option, defaults to `true`, and inherits from user scope unless the trusted project defines it.
- Deleting/removing a selected override removes only that scope's entry. Deleting a project server reveals a same-named user server; it does not disable it. To keep a definition without connecting on reload, set `enabled: false`.
- `effective` describes the determinable configuration across these files, **not current-session connection state**. Extension-registered runtime servers are outside this file backend; provenance always reports session state as unknown.

## Complete entries and local validation

`MCP_SCHEMA` declares every supported root and server field, including absent optional fields. Local validators additionally check names, transport combinations, URLs, and OAuth cross-field constraints. No runtime MCP validator is imported.

Server names use letters, digits, underscores, and hyphens. Transport can be implicit or explicit:

```json
{
  "autoEnableCodemode": true,
  "mcpServers": {
    "local_example": {
      "type": "stdio",
      "command": "example-mcp-server",
      "args": ["--read-only"],
      "env": { "TOKEN": "${EXAMPLE_TOKEN}" },
      "cwd": "relative/workspace",
      "enabled": false,
      "exposure": "hidden",
      "toolExposure": { "read_*": "direct" },
      "timeout": 60
    },
    "http_example": {
      "type": "http",
      "url": "https://example.invalid/mcp",
      "headers": { "X-Example-Token": "${EXAMPLE_TOKEN}" },
      "oauth": {
        "clientId": "synthetic-client",
        "clientSecret": "${EXAMPLE_CLIENT_SECRET}",
        "callbackPort": 8080,
        "callbackUrl": "http://localhost:8080/oauth/callback",
        "scope": "read"
      },
      "enabled": false,
      "exposure": "codemode",
      "toolExposure": { "private_*": "hidden" },
      "timeout": 30
    }
  }
}
```

Stdio supports `command`, string `args`, string-valued `env`, and `cwd`. HTTP supports an HTTP/HTTPS `url`, string-valued `headers`, and `oauth`. Do not combine stdio connection fields with HTTP fields. `streamable-http` is also accepted as the baseline runtime HTTP alias; legacy `sse` is rejected. Exposure values are `codemode`, `codemode-deferred`, `deferred`, `direct`, and `hidden`. Tool-exposure exact matches take priority over wildcard patterns; the first matching pattern takes priority over later patterns. Timeout is a finite positive number of seconds, not milliseconds.

OAuth supports optional `clientId`, `clientSecret`, `scope`, integer `callbackPort` (1–65535), and `callbackUrl`. Redirect URLs must use HTTP on `localhost`, `127.0.0.1`, or `[::1]`, without a query or fragment. An explicit non-default URL port must match a supplied callback port. A portless redirect can use the supplied port or let the host choose a free port. The baseline URL parser normalizes explicit `:80` to an absent port, so the local check retains that host behavior. Authentication itself remains a host `/mcp` operation.

## Masked editing and transactions

`readServer(name, scope)` is a **raw, backend-internal** storage read for composition/testing: never send its value to previews, search, logs, or normal UI. UI code must use `readDraft(name, scope)`, which masks environment values, header values, client secrets, and unknown fields. Metadata-only search must never index values.

Pass the complete draft and its revision to `writeServer(name, scope, revision, draft)`. Unchanged mask nodes retain the original persisted value; replacing a node with a string is deliberate, including an empty string. Masks with no corresponding original value are rejected. To create a project override from inheritance, edit the masked `effective` entry when `configured.present` is false. Values such as `${NAME}` and `!command` remain literal expressions in storage and are never evaluated here.

Operations:

- `writeServer(name, scope, revision, value)` creates or replaces a complete selected-scope entry.
- `renameServer(name, scope, revision, destination, value?)` renames a configured entry atomically; an optional complete draft can accompany the rename. Destination collisions reject the transaction.
- `deleteServer(name, scope, revision)` and `removeOverride(name, scope, revision)` remove only the selected scope's server.
- `readRootOption(name, scope)`, `writeRootOption(name, scope, revision, value)`, and `removeRootOption(name, scope, revision)` manage `autoEnableCodemode`.

No save occurs until a complete entry is submitted. Cancelling creation or editing means not submitting the draft; reads never create directories or files. There is no global Apply, rollback, or configuration undo.

Writes use shared `persistEntry`: serialized per-file mutation, conventional locking, entry-revision comparison, preservation of unrelated external edits and unknown content, and same-directory atomic replacement. Same-entry conflicts require refresh and re-edit. Invalid root shapes, invalid entries, and malformed files are reported with safe diagnostics rather than overwritten. Unknown future keys are preserved, not advertised as supported controls. Lock-ignoring external writers cannot be guaranteed conflict-free.

Successful `EditResult` acknowledges the saved entry and revision, returns a masked read for UI use, and reports `activation: { state: "required", requirement: "reload" }`. A later failed read-back does not erase persistence acknowledgement. Reload explicitly through the host to reconnect/activate changes; the settings backend never reloads automatically.
