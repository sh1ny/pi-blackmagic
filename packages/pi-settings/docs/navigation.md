# Controller and editor integration

`src/ui-controller.ts` exports `SettingsCenterController`, `CenterRow`,
`CenterOptions`, `CenterView`, `CenterBodyRow`, `CenterStatus`, and `DEFAULT_TABS`.
`src/editors.ts` exports `TypedEditor`, its view/outcome types, draft defaults,
redacted draft validation, safe value/display helpers, and printable decoding.
These modules do not open an overlay, start a terminal loop, access files, or
reload/restart the host.

```ts
const controller = new SettingsCenterController(rows, {
  onChange: () => tui.requestRender(),
  onClose: () => done(),
  bodyHeight: availableBodyRows,
});

// The host component delegates raw Pi terminal events unchanged.
controller.handleInput(rawInput);
controller.resize(availableBodyRows);
const view = controller.view();
// Render view, and dispose when the host custom component is removed.
controller.dispose();
```

The host owns full-viewport painting, ANSI/wide-character width handling,
truncation, tab-strip clipping, the editor's visible line window, and focus
restoration. Do not call an independent hide/clear/terminal loop. `onClose` is
called once for normal acknowledged closure. `dispose()` is idempotent teardown,
not a close request, and suppresses future callbacks. Exceptions from either
host callback are isolated.

## Row adapters and backend responsibilities

Each `CenterRow` contains a descriptor and promise-based `read(scope)` and
`write(transaction)` callbacks. Optional `removeOverride(transaction)` and
`delete(scope, revision)` callbacks expose visible reset/delete actions.
`keyCapture` enables a menu for recording one key, editing an assignment list,
or disabling an action. Recording starts explicitly and requires separate key
confirmation; list items also record individually. `initialValue` seeds an
intentional absent draft (including a create-entry wrapper), never copies an
inherited complex entry. `initialField` opens a structured field immediately.
Optional `editorSuggestions(scope)` prepares an advisory local suggestion resolver
under the controller deadline; errors fall back to typed editing, and late results
are guarded against navigation, withdrawal, and disposal. The resolver sees cloned,
redacted local draft contexts, not backend secrets; preparation is not run for
browse/search keystrokes. The default tabs are
General, Appearance, Models, Context, Tools, Keybindings, MCP, and Extensions.
Rows map to a tab through their page ID or the first component of their source
label; unmatched extension pages appear in Extensions. Custom tabs are optional.

Adapters own persistence queues, validation of the restored real value, trust,
activation, and masked-reference restoration. Optional
`warnings(transaction): Promise<readonly string[]>` checks advisory keybinding
conflicts before dispatch. Nonempty results show a count, contextual-overlap
caveat, and Cancel / Save despite warnings confirmation. Warning strings and
callback exceptions are not echoed verbatim. A failed/timed-out warning check
requires acknowledgement and dispatches no write; Escape cancels an incomplete
warning check or confirmation. The controller never resolves
credential expressions. It never supplies a substituted scope when a read is
unavailable. Exceptions and result diagnostics are not echoed: unavailable
scope messages explain lack of support or project trust, and failures use safe
fixed text. Actual values are redacted immediately before becoming controller
state. Masked fields remain retention markers in completed transactions; the
backend must restore them, not persist the markers as configuration.

The operation deadline defaults to 10 seconds (`operationTimeoutMs` is useful
for deterministic tests). Row callbacks have no signal parameter; adapters to
provider operations own any cooperative cancellation. A timed-out write is
indeterminate, not rolled back or declared successful. Late completion cannot
replace that status. After acknowledgement, activating that entry first does a
read-back without writing; a subsequent activation reads another fresh baseline
and starts editing. Keep the interaction's masked-reference vault alive until
already-dispatched operations have settled to their bounded outcomes.

## View structure

`view()` returns snapshots of:

- `tabs`, `tab`, `tabIndex`, the global `query`, and `navigationMode`
  (`settings` or `actions`). Render browse/action keyboard hints using this mode;
- `body`: the complete ordered row model, with stable `id`, `descriptorId`,
  `kind` (`setting`, `scope`, `reset`, `delete`), source label, supported scope,
  safe optional display value, `readState` (`loading`, `available`,
  `unavailable`, or `error`), and `selected` flag. Render safe Loading… /
  Unavailable / Read error placeholders from `readState`; an available read
  without a configured/effective value does not imply a default. `configured`
  is `null` until read, otherwise `{ present, value }`; `effective` similarly exposes
  `{ known, value }`. Display values are strings or `null` rather than raw JSON.
  `provenance` exposes `{ source, sessionState }` or `null`. The selected help
  distinguishes absent/inherited configuration, merged effective values, their
  source, and known/unknown host session state; saved state is not claimed to be
  active runtime state;
- `selected`: a body index or `null` for an empty page/result set;
- `visibleRows`, `scroll`, and `bodyHeight`: the independently bounded body
  window; `resize()` takes usable body height, not whole terminal height;
- `empty`, selected-entry `help`, and `status` (`kind`, safe message,
  `requiresAcknowledgement`);
- `editor`: `null` or `{ kind, path, lines, selected, input, cursor, message,
  help, picking? }`. `picking: true` means input is a local filter and the renderer
  must display its selectable lines, not replace them with a single text row. Lines contain a label, description, action name, and selected flag.
  The renderer keeps the editor's selected line visible separately from the
  background body. Sensitive input displays `[hidden draft]`, with no meaningful
  visible cursor, instead of the deliberately typed secret;
- `pending`, `closeRequested`, and `closed` lifecycle flags.

Display values substitute `[masked]` for retention markers: opaque marker
internals must not be rendered. Unknown structured fields are retained and
conservatively masked, not advertised as supported fields. No raw draft tree,
backend exception, or original sensitive value appears in a view snapshot.

`setRows(newRows)` atomically refreshes the metadata index and preserves stable
selection IDs where possible. Removed/replaced row adapters cancel incomplete
editors and invalidate late reads. Row adapters should retain their object
identity for unchanged registrations. Constructor and refresh enqueue the default
(or currently selected) declared scope of each row for background reads, with
at most four concurrent preloads. Safe available, unavailable, and error outcomes
are cached per descriptor/scope: stable refreshes do not retry failed reads or
read unchanged rows again. Other rows load independently of navigation; only
selected failures affect foreground status. Foreground activation always reads
a fresh revision, and per-key epochs prevent older background results from
replacing edit baselines or acknowledged saves. Withdrawal, replacement, closure,
and disposal invalidate queued/late results and suppress background callbacks.
Dispatched writes still settle even after withdrawal or disposal; a callback not yet dispatched is guarded against a stale
row. Registry validation and backend serialization remain adapter responsibilities.

## Keyboard ownership

- Browse (`navigationMode: "settings"`): Left/Right wraps tabs; each Up/Down
  moves exactly one setting and clamps at the first/last setting. Scope, reset,
  and delete rows remain in the complete body model for presentation mapping but
  are not browse navigation stops. Each tab remembers its selected setting.
  Enter edits/toggles that setting; arrows and Tab never write.
- Actions (`navigationMode: "actions"`): Tab enters the active descriptor’s
  actions, initially selecting Scope: user. Up/Down traverses only that
  descriptor’s user/project scope, optional reset, and optional delete rows.
  Enter activates the selected action. Unsupported scope choices remain explicit;
  selecting an unavailable scope explains why rather than silently redirecting.
  Reset removes only the selected override. Delete opens a confirmation with
  Cancel selected initially. Tab or Escape returns to the same descriptor’s
  setting before Escape can clear a query or close. Left/Right always returns
  to settings mode and changes tabs; printable text or Backspace returns to
  settings mode and updates the global query.
- Search: printable text begins a metadata-only global query immediately.
  Backspace removes one Unicode character. Results include source labels across
  all tabs and extensions; metadata marked private is excluded. Left/Right still
  changes the underlying tab without restricting results. Empty results have no
  selected entry. Escape clears search before closing. Searching itself performs
  no backend reads or writes, including Backspace clearing the last character.
  Initial catalog preloads may finish while typing; Enter reads the selected
  entry’s fresh baseline.
- Edit: arrows and typing belong exclusively to the editor. Scalar Enter
  confirms; choices select permitted values. The keybinding menu offers Record
  one key, Edit assignment list, and Disable action when the schema supports
  lists. After starting recording, confirming the captured key requires a
  separate Enter. List completion can save multiple assignments or an empty
  list to disable an action. Plus-key assignments rejected by baseline Pi are explained
  explicitly. Booleans save upon browse activation when their value is known.
  Escape cancels the entire incomplete entry, not any previously saved value.
- Catalog pickers: provider/model text fields and relevant list items/map keys
  can offer local suggestions without changing their text schemas. Type to filter
  names/IDs, Up/Down selects, and Enter confirms the selected value. Tab or the
  explicit Enter custom value action opens ordinary typed editing; Tab returns
  to choices. Unknown existing values remain selectable. Sensitive fields and
  key-capture never invoke suggestion resolvers. The picker owns input rather than
  changing the global query, and nested choice completion remains draft-local.
- Forms: structured fields include absent optional and required fields and their
  descriptions. Lists support typed add/edit/remove/reorder. Maps support typed
  add/edit/rename/remove and reject duplicate keys. Nested completions update
  only the local parent draft; Back discards an incomplete field. The visible
  root Complete entry action validates and autosaves exactly one entry.
  JSON input is used only for `kind: "json"`, never as a replacement for a typed
  list/map/structured form.
- Saving: no second edit dispatches before acknowledgement. Escape clears a
  query first, then requests closure and waits for the save outcome. Successful
  outcomes distinguish active, reload required, restart required, and saved but
  not active; nothing activates automatically. Failure/indeterminate outcomes
  retain the last confirmed persisted value and require Enter/Escape
  acknowledgement. A close requested during the save completes only after such
  a failure has been exposed and acknowledged.

A baseline revision is read at edit start and held through all local nested
edits. Absent structured/list/map/complex-union overrides start as new empty
entries rather than copying all inherited effective entries into a new scope.
Scalar effective values may initialize a scalar edit, but a masked inherited
value is never copied as a retain marker into an absent override.

Opaque `$token` retention markers can move with list items or renamed map keys
without changing their credential identity. The UI preserves their exact
markers and accepts only tokens present in the original entry. Legacy markers
without tokens remain supported at their original paths; operations that would
shift/rename their retention paths ask for deliberate replacement first. No
global Apply/Save, undo/history, or automatic reload operation exists.
