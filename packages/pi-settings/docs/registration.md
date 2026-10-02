# Extension settings registration (protocol v1)

Third-party settings are **opt-in and registration-only** in the initial release.
The center does not scan extension files, infer storage paths, parse extension
source, or provide legacy adapters. An empty Extensions tab means that no provider
has participated, not that every installed extension has no configuration.

Participating providers contribute specialized pages under **Extensions**. Global
search indexes descriptor identifiers, labels, descriptions and source/page labels,
never configured or effective values. `metadataSensitivity: "masked"` excludes a
descriptor from search; `sensitivity: "masked"` masks its value independently.

## Channels and payloads

Use the host's `pi.events` structural event bus:

```ts
interface SettingsEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}
```

| Channel | Payload |
| --- | --- |
| `pi-settings:v1:request` | `{ protocolVersion: 1 }` |
| `pi-settings:v1:register` | `{ protocolVersion: 1, extensionId, owner, displayName, pages, descriptors, operations }` |
| `pi-settings:v1:unregister` | `{ protocolVersion: 1, extensionId, owner }` |

`owner` is an object or symbol token compared by identity. Keep one token for the
provider's active runtime. Do not serialize it or use a shared string. Requests and
registrations are in-process objects, not JSON transports: operation functions and
owner identity must survive unchanged.

* `extensionId`, page `id` and descriptor `id` are nonempty stable identifiers,
  starting with an ASCII letter or digit and containing only letters, digits,
  `.`, `_`, `/` or `-`, up to 200 characters. Avoid reserved names
  `__proto__`, `constructor` and `prototype`. Namespace descriptor IDs with your
  extension ID, page and setting path to avoid global identity collisions.
* Pages have `{ id, label, description }`. Page IDs must be unique.
* Descriptors have `id`, `providerId` (equal to `extensionId`), a declared `pageId`,
  nonempty string-array `path`, `label`, `description`, `sourceLabel`, `schema`,
  nonempty unique `scopes` (`"user"` and/or `"project"`), `sensitivity`, optional
  `metadataSensitivity`, and `activation` (`"immediate"`, `"reload"`, `"restart"`).
* Metadata strings must not contain terminal/control escapes and are bounded to
  4,000 characters. Do not put secrets into public metadata. Descriptor IDs must
  be unique within and across registrations. A registration has at least one
  page and one descriptor. Metadata is snapshotted, not a mutable storage handle.
* Source labels are normalized to `Extensions / <displayName> / <page label>`.

Supported recursive schemas match the shared contracts:

| `kind` | Fields |
| --- | --- |
| `json` / `boolean` | No extra fields required |
| `text` | Optional nonnegative integer `minLength`, `maxLength` |
| `number` | Optional finite `minimum`, `maximum`, `exclusiveMinimum`, boolean `integer` |
| `choice` | Nonempty unique `values`: JSON scalar string/number/boolean/null |
| `union` | Nonempty `variants`: schemas |
| `list` | `item`: schema; optional nonnegative integer `minItems`, `maxItems` |
| `map` | `value`: schema |
| `structured` | `fields`: record of `{ schema, required: boolean, sensitivity: "public" or "masked", description }`; `preserveUnknown`: boolean |

Bounds must be ordered, schemas cannot be cyclic, and schema nesting is bounded
at 32 recursive levels. JSON values are finite, acyclic, credential-blind data
with a depth bound of 64. Validation does not evaluate `!command`, environment
references, credential expressions, endpoints or extension files.

## Complete raw protocol example: no settings package dependency

This JavaScript example uses only the supplied event bus and local extension-owned
state. It intentionally does not import `pi-settings` or its extension entrypoint.
Replace the local storage implementation with your extension's own backend; the
center will never locate or write that backend for you.

```js
export function installSettingsProvider(events) {
  const owner = {}; // fresh per runtime; stable across discovery responses
  let disposed = false;
  let configured = undefined;
  let revision = 0;

  function read(scope) {
    if (scope !== "user") {
      return { state: "unavailable", scope, reason: "Only user scope is supported." };
    }
    return {
      state: "available",
      scope,
      configured: configured === undefined
        ? { present: false }
        : { present: true, value: configured },
      effective: { known: true, value: configured ?? false },
      revision: String(revision),
      provenance: {
        source: configured === undefined ? "default" : "user",
        sessionState: "unknown",
      },
    };
  }

  const operations = {
    async read(descriptorId, scope, { signal }) {
      signal.throwIfAborted();
      if (descriptorId !== "example.tools.enabled") {
        return { state: "error", scope, message: "Unknown setting." };
      }
      return read(scope);
    },
    async validate(transaction, { signal }) {
      signal.throwIfAborted();
      return transaction.descriptorId === "example.tools.enabled"
        && transaction.scope === "user"
        && (transaction.operation === "remove-override"
          || (transaction.operation === "set" && typeof transaction.value === "boolean"))
        ? { valid: true }
        : { valid: false, message: "Unsupported edit." };
    },
    async write(transaction, { signal }) {
      signal.throwIfAborted();
      const validation = await operations.validate(transaction, { signal });
      if (!validation.valid) {
        return { state: "rejected", reason: "validation", message: "Invalid edit." };
      }
      if (transaction.expectedRevision !== String(revision)) {
        return { state: "rejected", reason: "conflict", message: "Read the current value first." };
      }
      signal.throwIfAborted();
      configured = transaction.value; // provider-owned acknowledged persistence
      revision++;
      return {
        state: "persisted",
        read: read(transaction.scope),
        activation: { state: "required", requirement: "reload" },
      };
    },
    async removeOverride(transaction, { signal }) {
      signal.throwIfAborted();
      if (transaction.operation !== "remove-override"
        || transaction.descriptorId !== "example.tools.enabled"
        || transaction.scope !== "user") {
        return { state: "rejected", reason: "validation", message: "Unsupported reset." };
      }
      if (transaction.expectedRevision !== String(revision)) {
        return { state: "rejected", reason: "conflict", message: "Read the current value first." };
      }
      configured = undefined;
      revision++;
      return { state: "persisted", read: read("user"), activation: { state: "active" } };
    },
  };

  const payload = {
    protocolVersion: 1,
    extensionId: "example",
    owner,
    displayName: "Example tools",
    pages: [{ id: "tools", label: "Tools", description: "Specialized tool behavior" }],
    descriptors: [{
      id: "example.tools.enabled",
      providerId: "example",
      pageId: "tools",
      path: ["enabled"],
      label: "Enabled",
      description: "Enable example tool behavior",
      sourceLabel: "Example tools",
      schema: { kind: "boolean" },
      scopes: ["user"],
      sensitivity: "public",
      activation: "reload",
    }],
    operations,
  };

  // Subscribe before announcing; the center may already be present.
  const off = events.on("pi-settings:v1:request", (request) => {
    if (!disposed && request?.protocolVersion === 1) {
      events.emit("pi-settings:v1:register", payload);
    }
  });
  events.emit("pi-settings:v1:register", payload);

  return function cleanup() {
    if (disposed) return;
    disposed = true;
    off();
    events.emit("pi-settings:v1:unregister", { protocolVersion: 1, extensionId: "example", owner });
  };
}

// In your extension's factory: const cleanup = installSettingsProvider(pi.events).
// Invoke cleanup on shutdown AND before replacing/unloading this runtime on reload.
// Continue registering your ordinary commands/tools whether a consumer exists or not.
```

The absence of a settings center is normal: emitting to an event bus with no
consumer does not require a package installation, storage access or acknowledgement.
Registration itself is not a persistence operation.

## Optional typed helper

The package's `./registration` subpath is side-effect-free. It exports protocol
constants and types, operation/schema contracts and `registerSettings`. It never
imports the root extension entrypoint, host runtime or registry, and never reads
or creates files.

```ts
import {
  registerSettings,
  type SettingsRegistration,
} from "@pi-blackmagic/pi-settings/registration";

// payload is your typed SettingsRegistration, with provider-owned operations.
function participate(pi: { events: Parameters<typeof registerSettings>[0] },
  payload: SettingsRegistration) {
  const cleanup = registerSettings(pi.events, payload);
  return cleanup; // call on shutdown and before runtime replacement/reload
}
```

The helper subscribes to v1 requests, immediately announces, and returns idempotent
cleanup that removes its request listener and emits an owner-matched withdrawal.
Repeated discoveries and openings re-announce without duplicate rows. Keep payload
metadata stable between announcements; announce changed metadata, callback
functions or the operations receiver object with the same owner to replace that
owner's registration. Reusing the same operations object and unchanged methods is
idempotent, including non-enumerable methods. Shared method functions on a new
operations object still replace the generation: callbacks bind `this` to that
original receiver.

## Operations, acknowledgement and deadlines

All callbacks return promises and receive `{ signal: AbortSignal }`. Reads take
`(descriptorId, scope, context)`; validation, writes and optional removal take
`(transaction, context)`. A transaction includes `descriptorId`, `scope`, opaque
`expectedRevision` and one of:

* `{ operation: "set", value }`
* `{ operation: "remove-override" }`
* `{ operation: "rename", destination, value }`

The provider decides whether rename or reset makes sense and enforces its own
revision/conflict policy. Reset uses `removeOverride`, never silently falls back
to `write`. A missing removal callback produces an unavailable rejection. The
registry checks scope, JSON/schema constraints and provider validation before
persistence, serializes edits per provider, and rejects concurrent submissions.
There is no global Apply, hidden storage adapter, automatic reload or undo.

Reads distinguish available scoped configured/effective values and revision from
unavailable/error states. Only `state: "persisted"` with an available read for the
requested scope and an activation result acknowledges saving. Activation is
`{ state: "active" }`, `{ state: "required", requirement: "reload" | "restart" }`,
or `{ state: "failed", requirement, message }`. The last case is **saved but not
active**, not a persistence failure. Other edit outcomes are `rejected` (validation,
conflict or unavailable), `failed`, or `indeterminate` with `requiresReadBack: true`.

**Each callback has a public default deadline of 10,000 ms (10 seconds).** A write
can first await validation with its own deadline and then persistence with another
10-second deadline. The registry's injectable scheduler exists for deterministic
fake-clock tests, not for weakening the production deadline. JavaScript callbacks
must yield to the event loop; synchronous CPU-bound code cannot be preempted.

* Read or validation exceptions/deadlines produce bounded sanitized errors. Failed
  validation never dispatches a write.
* Deadline expiry or cancellation aborts the callback's cooperative signal. A
  dispatched write/reset returns **indeterminate**, not a claim of rollback or
  failure to persist. Providers may ignore cancellation and commit late.
* After an indeterminate save, the entire provider is blocked from new writes.
  Retry requires BOTH settlement of the original callback AND a successful
  available read-back of the affected descriptor/scope started after settlement.
  A read made while the old write is still pending cannot unblock it, even if
  that read completes later. A failed/unsupported-scope read cannot unblock it.
  Same-owner replacement does not clear the barrier. If replacement retires the
  affected descriptor or scope, the next active edit automatically attempts a
  **private read-back using the original bound read callback and original ID/scope**
  after the old write settles. Recovery has the same 10-second deadline and
  cooperative cancellation. Only an available result from a read started after
  settlement, with the write-lane epoch still unchanged, clears that retired
  barrier. Failed, hanging, cancelled or late recovery results leave it blocked.
  A descriptor/scope that survives replacement still requires ordinary explicit
  user read-back; it is not recovered automatically.
* A provider that never settles remains write-blocked. Other providers and native
  pages remain independent. Late success/rejection is consumed without changing
  the already-returned timeout outcome or rendering an old value as a new save.
* Returned provider diagnostics and thrown exceptions are withheld in favor of
  generic messages, including read/unavailable, validation, save and activation
  failures. This deliberately sacrifices arbitrary provider error text to avoid
  accidental credential disclosure. Do not rely on raw message passthrough.

## Ownership, withdrawal and center lifecycle

The center subscribes before startup discovery and requests again whenever an
interaction opens. Same-owner/same-ID equivalent responses are idempotent.
Changed same-owner metadata/callbacks replace the old generation. A different
owner cannot take over an active `extensionId`; its registration and withdrawal
cannot evict the existing owner. Withdrawal is owner-matched and versioned.

The internal `SettingsRegistry` exposes `list()`, flattened `catalog()`, `open()`
(rediscovery), `operations(extensionId)` and `subscribe(listener)`. Catalogs are
copies with Extensions source labels. Notifications are:

* `registered`: refresh rows and re-index metadata search;
* `withdrawn`: remove `descriptorIds`, cancel incomplete editors without saving,
  and move selection to an available row; same-owner replacement also invalidates
  incomplete editing of the old generation;
* `diagnostic`: safe bounded registration compatibility/ownership errors;
  optional constructor option `onDiagnostic(safeMessage)` also receives these
  events, including synchronous constructor discovery before subscribers exist.
  Exceptions from this callback and subscription observers are isolated;
* `operation`: bounded persistence outcome state, descriptor ID, scope and
  `current` generation flag, **without values or revisions**.

Captured operation handles become stale on replacement, withdrawal or disposal:
new reads/validation/writes are rejected without invoking old callbacks. Already
dispatched saves remain bounded and observable even after withdrawal. An in-flight
save may acknowledge persistence after its row disappears; record its outcome,
but do not reinsert the row or apply the result to a new editor. Use the operation
notification's `current` flag and editor-generation guards to prevent stale UI
updates. Never treat withdrawal as rollback.

On shutdown/reload call the center's `dispose()` and each provider's cleanup.
Center disposal removes bus listeners and catalogs immediately, aborts cooperative
operations, and retains existing bounded save-outcome observers until those wrapper
promises settle. Create a new registry for the fresh runtime. Cancellation/unload
cannot stop noncooperating trusted code or undo an earlier commit.

## Secrets and trust boundary

`maskRead()` produces ordinary-display configured/effective values through the
shared masking rules; masked descriptor values, declared sensitive structured
fields, credential fields and unknown structured fields are not displayed raw.
The registry privately snapshots available raw scoped reads by provider generation,
descriptor ID and scope, independently of the returned read object. Ordinary
provider operation reads retain their raw API semantics; display/editor masking
uses opaque retention references, never raw secrets in token metadata. Before
both direct validation and persistence, the registry resolves masked drafts with
shared restoration against that **private raw baseline**, requiring the draft's
`expectedRevision` to match the baseline revision. It validates the restored value,
not the marker's shape, and supplies cloned raw transactions to provider callbacks.
Providers never receive retention markers as text or JSON setting values.

A masked draft without a matching raw configured baseline, an expired reference,
or a new masked field with no original value is rejected before provider dispatch;
refresh the entry instead. Replacement, withdrawal and disposal clear private raw
snapshots, and dispatched writes invalidate the affected baseline. Retention never
evaluates credential expressions, executes commands or logs raw values. Deliberate
replacements, including an empty string where the schema permits it, are input,
not retention. Opaque revision tokens and secret-bearing read results are not
diagnostics or search inputs. Do not log full transactions, raw result values or
provider exceptions.

Descriptor validation and callback isolation are **not a security sandbox**.
In-process extensions are trusted code with host/process privileges. They own
scope authorization (including project trust), storage, conflicts and activation.
The center validates the protocol, local schema and safe outcome boundaries; it
cannot prove that an extension's callbacks are honest, undo side effects, inspect
its undisclosed storage, or preempt synchronous infinite loops.
