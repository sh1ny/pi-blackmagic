# Provider and model configuration (Pi 0.99.1)

The models backend edits **user-only** `models.json` in Pi's public agent directory (`getAgentDir()`), not a hardcoded home directory. Project model configuration is unsupported, even in trusted projects; requests are rejected rather than redirected. Construction and reads create no directories or files. Tests can inject an agent-directory resolver.

This is saved configuration, not the current session's model catalog or selected model. Every successful edit reports **reload required**, with effective/session state unknown. The backend does not reload automatically, select a model, or modify startup defaults in `settings.json`.

## Catalog-backed choices in the Models page

The UI offers searchable local choices for Default provider, Default model,
Enabled models items, Model Thinking Levels keys, Add provider, and provider renames. Default model
choices follow the saved provider in the selected scope; project edits inherit the
user provider when no project provider is set. Session/CLI overrides are not used
to choose a startup default. With no saved provider, models are labelled by provider.
Enabled models and per-model thinking keys use `provider/modelId` values.

Add provider opens the provider picker first, then returns to its complete-entry
form. Within provider forms, model IDs, model-override keys, API types, and
fallback provider/model IDs offer matching catalog choices. Required form fields
still validate, and no partial provider is saved. Already configured provider names
remain visible, but adding or renaming into an occupied name is rejected; edit its existing Provider row.

Type to filter by name or ID, use Up/Down, and Enter to choose. **Enter custom
value…** or Tab switches to free-text editing; Tab returns to choices. Existing
unlisted values remain selectable, including custom model IDs and enabled-model
patterns. Suggestions do not narrow the backend schema or change the active model.

Choices combine Pi's existing synchronous model metadata snapshot, registered
provider IDs, and public IDs/names/API types from the user `models.json` already
read by the catalog. Newly saved definitions become selectable without a host
reload. Locally known models are not a guarantee of credentials, endpoint
availability, or live service support. The UI does not call authentication APIs,
refresh the host model runtime, query providers, resolve keys/commands, or inspect
credential stores to populate these choices. Sensitive configuration never
becomes suggestion data. Missing metadata leaves custom editing available.

## Transaction API

`ModelsBackend(context: ProjectContext, agentDirectory?: () => string)` offers these asynchronous operations; scope defaults to `"user"`:

- `readProvider(providerId, scope?)` → `ScopedReadResult` with masked configured data and provider revision.
- `writeProvider(providerId, completeDraft, expectedRevision, scope?)` → create or replace the complete provider entry.
- `renameProvider(providerId, destinationId, expectedRevision, scope?)` / `deleteProvider(providerId, expectedRevision, scope?)`.
- `addModel(providerId, completeModel, providerRevision, scope?)` / `editModel(providerId, modelId, completeModel, providerRevision, scope?)`.
- `renameModel(providerId, modelId, destinationId, providerRevision, scope?)` / `deleteModel(providerId, modelId, providerRevision, scope?)`.
- `writeOverride(providerId, modelId, completeOverride, providerRevision, scope?)` → create or edit an override, including one targeting a built-in model.
- `renameOverride(providerId, modelId, destinationId, providerRevision, scope?)` / `deleteOverride(providerId, modelId, providerRevision, scope?)`.

All mutations return `EditResult`. A successful result contains a freshly masked **provider** read and its revision, including after a model/override operation; deletion returns an absent provider. Use that revision for the next edit. Model arrays and override maps are changed in a single provider transaction, never through partial-entry writes. An externally changed provider—including another model within it—rejects a stale edit. Concurrent edits to different providers safely merge. Renames reject occupied destinations. Model edits require exactly one existing matching ID and cannot silently rename it; use `renameModel`. The baseline allows duplicate IDs in complete provider definitions, but identity-based mutations reject ambiguous IDs.

Model rename also renames that model's associated override atomically; an occupied destination model or override blocks it. Model deletion deliberately retains overrides, which may still apply to a built-in model. Override rename changes only its map key, not model definitions. Model operations require an existing provider. Entry IDs used by the API must be nonempty; baseline map keys otherwise remain unmodified, including unknown IDs and prototype-like names.

Complete drafts may omit known optional fields to remove them. Unknown future fields are retained at corresponding structured nodes, including provider, compatibility, model and override metadata. Whole-provider drafts align model secret retention by model ID, not array position, so reordering cannot transfer credentials between models. Use the explicit rename method to change IDs while retaining masked model fields. Malformed files or known schema violations are reported without overwriting them. BOM and baseline JSON comments are accepted; successful writes normalize to formatted JSON, preserving semantic unrelated/unknown content, not comments or whitespace.

Persistence uses the shared conventional path lock, per-path queue, revision check under lock, same-directory temporary file and atomic replacement. It never falls back to truncating writes. Lock-ignoring external writers cannot be made fully conflict-free.

## Complete baseline fields

The credential-blind local `MODELS_SCHEMA` is reviewed against the installed Pi 0.99.1 `dist/core/model-config.js` TypeBox definitions. Descriptor coverage is checked against the reviewed `pi-0.99.1-coverage.json` fixture. No host `ModelConfig`, `ModelRegistry`, schema compilation or runtime schema evaluation is needed.

Unless identified as required, all listed fields are optional. Unknown future object fields remain valid and are not advertised as newly supported options. Strings have no URL/API-name enumeration unless stated. Numeric fields are finite numbers; no positivity or integer restriction is invented where the baseline has none.

### Root and providers

Root `providers` is a **required** object/map. Every provider entry is an object with:

| Field | Accepted value |
| --- | --- |
| `name`, `baseUrl`, `api` | Nonempty string; `api` can name a custom API |
| `apiKey` | Nonempty literal credential or credential reference string; masked |
| `oauth` | Literal `"radius"` |
| `headers` | String-valued map, including empty strings; all values masked |
| `authHeader` | Boolean |
| `compat` | Compatibility object detailed below |
| `models` | Array of complete model definitions; empty allowed |
| `modelOverrides` | Map of model IDs to override objects; empty allowed |

An empty provider object is valid; endpoints, API keys and model lists are not required by the baseline schema.

### Models and overrides

A model requires only `id` (nonempty string). It optionally supports `api` and `baseUrl` (nonempty strings). Overrides do not advertise these identity/endpoint fields: the map key identifies the target. Unknown fields are preserved, not inferred as supported overrides.

Both models and overrides support:

- `name`: nonempty string.
- `reasoning`: boolean.
- `thinkingLevelMap`: object with optional `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; each value is any string or `null`.
- `input`: array of `"text"` and/or `"image"`; empty allowed.
- `inputLimits`: object with optional `maxRequestBytes` (integer ≥ 1) and `images` object. `images.maxPerMessage` and `images.maxPerRequest` are integers ≥ 1. `images.resize` supports `maxWidth`, `maxHeight`, `maxBytes` (integers ≥ 1) and `jpegQuality` (integer 1–100).
- `cost`: object with `input`, `output`, `cacheRead`, `cacheWrite` numeric rates. **All four rates are required in a model or fallback cost**, but individually optional in an override's cost. `tiers` is an optional array; each tier always requires numeric `inputTokensAbove`, `input`, `output`, `cacheRead`, `cacheWrite`. Empty tier arrays are valid. Rates and thresholds have no additional numeric bounds.
- `promptCache`: object with optional numeric `short`, `long`, each **strictly greater than zero**; fractional values are valid.
- `contextWindow`, `maxTokens`: numbers without additional baseline bounds.
- `samplingParams`: map of arbitrary JSON values, including nested objects/arrays, booleans and null. Validation does not evaluate these parameters.
- `headers`: string-valued map; values masked.
- `compat`: full compatibility metadata below.

### Compatibility branches

Provider, model and override `compat` share all three baseline branches: OpenAI completions, OpenAI responses, and Anthropic messages. The baseline's branches are optional-property objects without a discriminator. The local schema represents their complete known-field union and validates every present known field, rather than letting an invalid completions/Anthropic option bypass validation by matching a different empty branch. Future unknown fields are still preserved. API-specific behavior remains the host's responsibility.

**OpenAI completions** boolean fields:
`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `supportsFinishReason`, `requiresToolResultName`, `requiresAssistantAfterToolResult`, `requiresThinkingAsText`, `requiresReasoningContentOnAssistantMessages`, `supportsOpenAIGrammarTools`, `supportsStrictMode`, `sendSessionAffinityHeaders`, `supportsLongCacheRetention`.

Other completions fields:

- `maxTokensField`: `"max_completion_tokens"` or `"max_tokens"`.
- `thinkingFormat`: `"openai"`, `"openrouter"`, `"together"`, `"baseten"`, `"deepseek"`, `"zai"`, `"qwen"`, `"chat-template"`, `"qwen-chat-template"`, `"string-thinking"`, `"ant-ling"`.
- `chatTemplateKwargs`, `chatTemplateArgs`: maps whose values are string, number, boolean, null, or a variable object. Variable objects require `$var` equal to `"thinking.enabled"` or `"thinking.effort"`; optional `omitWhenOff` is boolean.
- `cacheControlFormat`: literal `"anthropic"`.
- `openRouterRouting`, `vercelGatewayRouting`: routing objects below.
- `sessionAffinityFormat`: `"openai"`, `"openai-nosession"` or `"openrouter"`.
- `vllmPriority`: number.

**OpenAI responses** boolean fields:
`supportsDeveloperRole`, `supportsLongCacheRetention`, `supportsStrictMode`, `supportsOpenAIGrammarTools`, `supportsMaxOutputTokens`.
Its `sessionAffinityFormat` accepts the same three values above.

**Anthropic messages** boolean fields:
`supportsEagerToolInputStreaming`, `supportsLongCacheRetention`, `sendSessionAffinityHeaders`, `supportsCacheControlOnTools`, `supportsTemperature`, `forceAdaptiveThinking`, `allowEmptySignature`, `supportsStrictTools`, `supportsMidConvoEffort`.
`allowedFallbackModels` is an array of **at most three** entries (empty allowed); each requires nonempty strings `provider`, `model`, and complete `cost` rates with optional full tiers as described above.

### Routing

`openRouterRouting` supports:

- Booleans `allow_fallbacks`, `require_parameters`, `zdr`, `enforce_distillable_text`.
- `data_collection`: `"deny"` or `"allow"`.
- String arrays `order`, `only`, `ignore`, `quantizations`; empty arrays allowed.
- `sort`: string or object with optional string `by` and optional string-or-null `partition`.
- `max_price`: object with optional `prompt`, `completion`, `image`, `audio`, `request`, each number or string.
- `preferred_min_throughput`, `preferred_max_latency`: number or percentile object with optional numeric `p50`, `p75`, `p90`, `p99`.

`vercelGatewayRouting` supports optional string arrays `only`, `order`.

## Credentials and safety

`apiKey` and header values may contain environment-variable names or literal `!command` references according to the host's credential-resolution semantics. They are stored as configuration expressions; **this backend never looks up variables or executes commands**. It does not launch processes, instantiate host model registries, make model calls, probe endpoints, or implicitly choose the current session model. A provider's OAuth selection is configuration only.

`auth.json` is explicitly excluded: it is neither read nor written, inspected for effective credentials, nor offered as an editor. Host-managed OAuth tokens and credential-store operations remain outside this backend.

Reads and acknowledgements mask credentials, all header values and unknown structured fields through the shared redaction helpers. Drafts retain the shared masked sentinel for an unchanged field. Replacing a sentinel with a literal deliberately changes the value; an empty header string is an explicit replacement, while an empty API key fails its nonempty-string constraint. Omitted known fields are removed, not interpreted as retention. A new masked node without an original value fails safely. Do not use raw persisted content as search data or previews; descriptor metadata is the safe search surface. Diagnostics are fixed/sanitized and never interpolate submitted values, credential expressions, endpoint URLs or caught exception details.
