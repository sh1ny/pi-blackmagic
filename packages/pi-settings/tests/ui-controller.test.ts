import { expect, test } from "bun:test";
import type {
  ActivationResult,
  EditResult,
  EditTransaction,
  JsonValue,
  ScopedReadResult,
  SettingDescriptor,
  ValueSchema,
} from "../src/contracts.ts";
import {
  type CenterRow,
  SettingsCenterController,
} from "../src/ui-controller.ts";

const key = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  end: "\x1b[F",
};
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function read(
  value: JsonValue,
  revision = "r1",
): Extract<ScopedReadResult, { state: "available" }> {
  return {
    state: "available",
    scope: "user",
    configured: { present: true, value },
    effective: { known: true, value },
    revision,
    provenance: { source: "user", sessionState: "unknown" },
  };
}
function persisted(
  value: JsonValue,
  activation: ActivationResult = { state: "required", requirement: "reload" },
): EditResult {
  return { state: "persisted", read: read(value, "r2"), activation };
}
function fixture(
  id = "enabled",
  pageId = "General",
  value: JsonValue = false,
  schema: ValueSchema = { kind: "boolean" },
) {
  const descriptor: SettingDescriptor = {
    id,
    providerId: "native",
    pageId,
    path: [id],
    label: id,
    description: `Description of ${id}`,
    sourceLabel: pageId,
    schema,
    scopes: ["user", "project"],
    sensitivity: "public",
    activation: "reload",
  };
  const writes: EditTransaction[] = [];
  const reads: string[] = [];
  let current = read(value);
  const row: CenterRow = {
    descriptor,
    async read(scope) {
      reads.push(scope);
      return { ...current, scope };
    },
    async write(transaction) {
      writes.push(transaction);
      if (transaction.operation !== "set")
        return { state: "failed", message: "Unexpected operation" };
      current = read(transaction.value, "r2");
      return persisted(transaction.value);
    },
  };
  return {
    row,
    writes,
    reads,
    setRead: (result: typeof current) => {
      current = result;
    },
  };
}
function center(rows: CenterRow[], timeout = 100) {
  let changes = 0;
  let closes = 0;
  const controller = new SettingsCenterController(rows, {
    onChange: () => changes++,
    onClose: () => closes++,
    operationTimeoutMs: timeout,
    bodyHeight: 3,
  });
  return { controller, changes: () => changes, closes: () => closes };
}
function selected(controller: SettingsCenterController) {
  return controller.view().body.find((entry) => entry.selected);
}
function moveTo(
  controller: SettingsCenterController,
  predicate: (entry: NonNullable<ReturnType<typeof selected>>) => boolean,
) {
  const target = controller.view().body.find(predicate);
  expect(target).toBeDefined();
  if (!target) return;
  if (controller.view().navigationMode === "actions")
    controller.handleInput(key.tab);
  const settings = controller
    .view()
    .body.filter((entry) => entry.kind === "setting");
  const targetIndex = settings.findIndex(
    (entry) => entry.descriptorId === target.descriptorId,
  );
  const settingIndex = () =>
    settings.findIndex((entry) => entry.id === selected(controller)?.id);
  while (settingIndex() < targetIndex) controller.handleInput(key.down);
  while (settingIndex() > targetIndex) controller.handleInput(key.up);
  if (target.kind === "setting") return;
  controller.handleInput(key.tab);
  const actions = controller
    .view()
    .body.filter(
      (entry) =>
        entry.descriptorId === target.descriptorId && entry.kind !== "setting",
    );
  const actionIndex = () =>
    actions.findIndex((entry) => entry.id === selected(controller)?.id);
  const targetAction = actions.findIndex((entry) => entry.id === target.id);
  while (actionIndex() < targetAction) controller.handleInput(key.down);
  while (actionIndex() > targetAction) controller.handleInput(key.up);
}
function editorAction(controller: SettingsCenterController, prefix: string) {
  const editor = controller.view().editor;
  const index =
    editor?.lines.findIndex((line) => line.label.startsWith(prefix)) ?? -1;
  expect(index).toBeGreaterThanOrEqual(0);
  while ((controller.view().editor?.selected ?? 0) < index)
    controller.handleInput(key.down);
  while ((controller.view().editor?.selected ?? 0) > index)
    controller.handleInput(key.up);
  controller.handleInput(key.enter);
}
function replaceText(controller: SettingsCenterController, value: string) {
  controller.handleInput(key.end);
  for (let i = 0; i < 100; i++) controller.handleInput(key.backspace);
  controller.handleInput(value);
}

test("default tabs wrap, rows clamp, selection is remembered by tab, and arrows never write", async () => {
  const a = fixture();
  const b = fixture("theme", "Appearance", "system", { kind: "text" });
  const state = center([a.row, b.row]);
  await tick();
  expect(state.controller.view().tabs).toEqual([
    "General",
    "Appearance",
    "Models",
    "Context",
    "Tools",
    "Keybindings",
    "MCP",
    "Extensions",
  ]);
  state.controller.handleInput(key.up);
  expect(state.controller.view().selected).toBe(0);
  state.controller.handleInput(key.down);
  expect(selected(state.controller)?.kind).toBe("setting");
  state.controller.handleInput(key.right);
  expect(state.controller.view().tab).toBe("Appearance");
  state.controller.handleInput(key.down);
  state.controller.handleInput(key.left);
  expect(state.controller.view().selected).toBe(0);
  state.controller.handleInput(key.left);
  expect(state.controller.view().tab).toBe("Extensions");
  state.controller.handleInput(key.right);
  for (let i = 0; i < 20; i++) state.controller.handleInput(key.down);
  expect(state.controller.view().selected).toBe(0);
  expect(a.writes).toEqual([]);
  expect(b.writes).toEqual([]);
  state.controller.dispose();
});

test("body resizing keeps selection visible; render width is not a controller concern", async () => {
  const rows = Array.from({ length: 8 }, (_, i) => fixture(`row-${i}`).row);
  const { controller } = center(rows);
  await tick();
  for (let i = 0; i < 15; i++) controller.handleInput(key.down);
  expect(selected(controller)?.descriptorId).toBe("row-7");
  expect(controller.view().scroll).toBe(19);
  controller.resize(1);
  expect(controller.view().visibleRows).toHaveLength(1);
  expect(controller.view().visibleRows[0]?.selected).toBe(true);
  controller.resize(50);
  expect(controller.view().scroll).toBe(0);
  expect(controller.view().help).toContain("Description");
  controller.dispose();
});

test("immediate global search has source labels, retains global query on tabs, and clears with no stale entry", async () => {
  const a = fixture("native-setting");
  const b = fixture("plugin-setting", "ExtraPage");
  b.row.descriptor.providerId = "extension";
  b.row.descriptor.sourceLabel = "Extensions / Plugin / ExtraPage";
  const privateMetadata = fixture("private-secret-label");
  privateMetadata.row.descriptor.metadataSensitivity = "masked";
  const { controller } = center([a.row, b.row, privateMetadata.row]);
  await tick();
  controller.handleInput(key.down);
  controller.handleInput("PLUGIN");
  expect(controller.view().query).toBe("PLUGIN");
  expect(controller.view().body[0]?.sourceLabel).toBe(
    "Extensions / Plugin / ExtraPage",
  );
  controller.handleInput(key.right);
  expect(controller.view().tab).toBe("Appearance");
  expect(controller.view().body[0]?.descriptorId).toBe("plugin-setting");
  controller.handleInput("no-match");
  expect(controller.view()).toMatchObject({
    empty: true,
    selected: null,
    scroll: 0,
  });
  controller.handleInput(key.enter);
  await tick();
  expect(b.writes).toHaveLength(0);
  controller.handleInput(key.escape);
  expect(controller.view().query).toBe("");
  expect(controller.view().tab).toBe("Appearance");
  controller.handleInput(key.left);
  expect(controller.view().selected).toBe(3);
  controller.handleInput("private-secret-label");
  expect(controller.view().empty).toBe(true);
  controller.handleInput(key.escape);
  controller.handleInput("plugin");
  controller.setRows([a.row]);
  expect(controller.view().empty).toBe(true);
  controller.setRows([a.row, b.row]);
  expect(controller.view().body[0]?.descriptorId).toBe("plugin-setting");
  controller.handleInput(key.backspace);
  expect(controller.view().query).toBe("plugi");
  controller.dispose();
});

test("toggles read a fresh edit-start revision, save on activation, and require backend acknowledgement", async () => {
  const a = fixture();
  const save = deferred<EditResult>();
  a.row.write = async (transaction) => {
    a.writes.push(transaction);
    return save.promise;
  };
  const { controller } = center([a.row]);
  await tick();
  a.setRead(read(false, "fresh-baseline"));
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes).toEqual([
    {
      descriptorId: "enabled",
      scope: "user",
      expectedRevision: "fresh-baseline",
      operation: "set",
      value: true,
    },
  ]);
  expect(controller.view().status.kind).toBe("saving");
  expect(controller.view().body[0]?.value).toBe("false");
  save.resolve(persisted(true));
  await tick();
  expect(controller.view().body[0]?.value).toBe("true");
  expect(controller.view().status.message).toContain("reload required");
  controller.dispose();
});

test("text arrows and typing exclusively belong to the editor, then Enter autosaves", async () => {
  const a = fixture("text-setting", "General", "before", {
    kind: "text",
    minLength: 1,
  });
  const { controller } = center([a.row]);
  await tick();
  controller.handleInput(key.enter);
  await tick();
  controller.handleInput(key.left);
  controller.handleInput("x");
  expect(controller.view().tab).toBe("General");
  expect(controller.view().query).toBe("");
  expect(controller.view().editor?.input).toBe("beforxe");
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes[0]).toMatchObject({
    expectedRevision: "r1",
    value: "beforxe",
  });
  expect(controller.view().editor).toBeNull();
  controller.handleInput(key.enter);
  await tick();
  controller.handleInput("unfinished");
  controller.handleInput(key.escape);
  expect(a.writes).toHaveLength(1);
  expect(controller.view().body[0]?.value).toBe('"beforxe"');
  expect(controller.view().closed).toBe(false);
  controller.dispose();
});

test("scopes and reset are visible Enter actions; unavailable scopes never silently redirect", async () => {
  const a = fixture();
  a.row.descriptor.scopes = ["user"];
  a.row.removeOverride = async (transaction) => {
    a.writes.push(transaction);
    return persisted(false);
  };
  const { controller } = center([a.row]);
  await tick();
  moveTo(
    controller,
    (entry) => entry.kind === "scope" && entry.scope === "project",
  );
  controller.handleInput(key.enter);
  await tick();
  expect(controller.view().status.kind).toBe("unavailable");
  expect(controller.view().status.message).toContain(
    "No scope was substituted",
  );
  expect(a.reads).not.toContain("project");
  moveTo(controller, (entry) => entry.kind === "setting");
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes).toHaveLength(0);
  moveTo(
    controller,
    (entry) => entry.kind === "scope" && entry.scope === "user",
  );
  controller.handleInput(key.enter);
  await tick();
  moveTo(controller, (entry) => entry.kind === "reset");
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes).toEqual([
    {
      descriptorId: "enabled",
      scope: "user",
      expectedRevision: "r1",
      operation: "remove-override",
    },
  ]);
  controller.dispose();
});

test("trust-gated scope provides a safe unavailable reason even if callbacks include credential text", async () => {
  const a = fixture();
  a.row.read = async (scope) =>
    scope === "project"
      ? {
          state: "unavailable",
          scope,
          reason: "untrusted project synthetic-secret",
        }
      : read(false);
  const { controller } = center([a.row]);
  await tick();
  moveTo(
    controller,
    (entry) => entry.kind === "scope" && entry.scope === "project",
  );
  controller.handleInput(key.enter);
  await tick();
  expect(controller.view().status.message).toContain("not trusted");
  expect(JSON.stringify(controller.view())).not.toContain("synthetic-secret");
  controller.dispose();
});

test("structured nested edits are local, completion writes one whole entry, Escape writes no partial form", async () => {
  const schema: ValueSchema = {
    kind: "structured",
    preserveUnknown: false,
    fields: {
      command: {
        schema: { kind: "text", minLength: 1 },
        required: true,
        sensitivity: "public",
        description: "Server command.",
      },
      args: {
        schema: { kind: "list", item: { kind: "text" } },
        required: false,
        sensitivity: "public",
        description: "Argument list.",
      },
      env: {
        schema: { kind: "map", value: { kind: "text" } },
        required: false,
        sensitivity: "public",
        description: "Environment variables.",
      },
    },
  };
  const a = fixture("server", "MCP", { command: "local" }, schema);
  const { controller } = center([a.row]);
  controller.handleInput("server");
  controller.handleInput(key.enter);
  await tick();
  editorAction(controller, "args");
  editorAction(controller, "Add item");
  controller.handleInput("--unfinished");
  controller.handleInput(key.escape);
  expect(a.writes).toHaveLength(0);
  expect(controller.view().query).toBe("server");
  controller.handleInput(key.enter);
  await tick();
  editorAction(controller, "env");
  editorAction(controller, "Add key");
  controller.handleInput("MODE");
  controller.handleInput(key.enter);
  controller.handleInput("safe");
  controller.handleInput(key.enter);
  expect(a.writes).toHaveLength(0);
  editorAction(controller, "Complete entry");
  expect(a.writes).toHaveLength(0);
  editorAction(controller, "Complete entry");
  await tick();
  expect(a.writes).toHaveLength(1);
  expect(a.writes[0]).toMatchObject({
    value: { command: "local", env: { MODE: "safe" } },
  });
  controller.dispose();
});

test("absent structured overrides do not copy inherited map/list/field entries into the selected scope", async () => {
  const schemas: ValueSchema[] = [
    { kind: "map", value: { kind: "text" } },
    { kind: "list", item: { kind: "text" } },
    {
      kind: "structured",
      preserveUnknown: true,
      fields: {
        optional: {
          schema: { kind: "text" },
          required: false,
          sensitivity: "public",
          description: "Optional field.",
        },
      },
    },
  ];
  for (const [index, schema] of schemas.entries()) {
    const inherited: JsonValue =
      schema.kind === "list"
        ? ["inherited"]
        : { optional: "inherited", future: "inherited" };
    const a = fixture(`inherit-${index}`, "General", inherited, schema);
    a.row.read = async (scope) => ({
      ...read(inherited),
      scope,
      configured: { present: false },
      provenance: { source: "user", sessionState: "unknown" },
    });
    const { controller } = center([a.row]);
    await tick();
    controller.handleInput(key.enter);
    await tick();
    expect(JSON.stringify(controller.view().editor)).not.toContain("inherited");
    editorAction(controller, "Complete entry");
    await tick();
    expect(a.writes[0]).toMatchObject({
      value: schema.kind === "list" ? [] : {},
    });
    controller.dispose();
  }
});

test("sensitive descriptors and fields never reveal existing or deliberately typed replacement values", async () => {
  const schema: ValueSchema = {
    kind: "structured",
    preserveUnknown: true,
    fields: {
      label: {
        schema: { kind: "text" },
        required: true,
        sensitivity: "public",
        description: "Public label.",
      },
      privateField: {
        schema: { kind: "text" },
        required: false,
        sensitivity: "masked",
        description: "Credential.",
      },
    },
  };
  const a = fixture(
    "private-setting",
    "General",
    { label: "visible", privateField: "synthetic-original" },
    schema,
  );
  const { controller } = center([a.row]);
  await tick();
  expect(JSON.stringify(controller.view())).not.toContain("synthetic-original");
  controller.handleInput(key.enter);
  await tick();
  editorAction(controller, "privateField");
  editorAction(controller, "Retain");
  editorAction(controller, "Complete entry");
  await tick();
  expect(a.writes[0]).toMatchObject({
    value: { label: "visible", privateField: { $piSettingsMasked: true } },
  });
  controller.handleInput(key.enter);
  await tick();
  editorAction(controller, "privateField");
  editorAction(controller, "Replace");
  controller.handleInput("synthetic-replacement");
  expect(JSON.stringify(controller.view())).not.toContain(
    "synthetic-replacement",
  );
  expect(controller.view().editor?.input).toBe("[hidden draft]");
  controller.handleInput(key.enter);
  editorAction(controller, "Complete entry");
  await tick();
  expect(a.writes[1]).toMatchObject({
    value: { label: "visible", privateField: "synthetic-replacement" },
  });
  expect(JSON.stringify(controller.view())).not.toContain(
    "synthetic-replacement",
  );
  controller.dispose();
  const root = fixture("root-secret", "General", "synthetic-root-secret", {
    kind: "text",
  });
  root.row.descriptor.sensitivity = "masked";
  const rootState = center([root.row]);
  await tick();
  rootState.controller.handleInput(key.enter);
  await tick();
  editorAction(rootState.controller, "Replace");
  rootState.controller.handleInput("synthetic-root-replacement");
  expect(rootState.controller.view().editor?.input).toBe("[hidden draft]");
  rootState.controller.handleInput(key.escape);
  expect(root.writes).toHaveLength(0);
  rootState.controller.dispose();
});

test("normal closure waits for pending save success", async () => {
  const a = fixture();
  const outcome = deferred<EditResult>();
  a.row.write = async () => outcome.promise;
  const state = center([a.row]);
  await tick();
  state.controller.handleInput(key.enter);
  await tick();
  state.controller.handleInput(key.escape);
  expect(state.closes()).toBe(0);
  expect(state.controller.view().closeRequested).toBe(true);
  outcome.resolve(persisted(true));
  await tick();
  expect(state.closes()).toBe(1);
  expect(state.controller.view().closed).toBe(true);
  state.controller.handleInput(key.escape);
  state.controller.dispose();
  state.controller.dispose();
  expect(state.closes()).toBe(1);
});

test("close-request during failed pending save exposes safe failure until acknowledgement, retaining persisted value", async () => {
  const a = fixture();
  const outcome = deferred<EditResult>();
  a.row.write = async () => outcome.promise;
  const state = center([a.row]);
  await tick();
  state.controller.handleInput(key.enter);
  await tick();
  state.controller.handleInput(key.escape);
  outcome.reject(new Error("synthetic-credential-in-exception"));
  await tick();
  expect(state.closes()).toBe(0);
  expect(state.controller.view().status).toMatchObject({
    kind: "failure",
    requiresAcknowledgement: true,
  });
  expect(state.controller.view().body[0]?.value).toBe("false");
  expect(JSON.stringify(state.controller.view())).not.toContain(
    "synthetic-credential",
  );
  state.controller.handleInput("x");
  expect(state.controller.view().query).toBe("");
  state.controller.handleInput(key.enter);
  expect(state.closes()).toBe(1);
  state.controller.dispose();
});

test("failed write cannot masquerade as saved; acknowledgement permits fresh-baseline retry", async () => {
  const a = fixture();
  a.row.write = async (transaction) => {
    a.writes.push(transaction);
    return {
      state: "rejected",
      reason: "conflict",
      message: "synthetic-private-error",
    };
  };
  const { controller } = center([a.row]);
  await tick();
  controller.handleInput(key.enter);
  await tick();
  expect(controller.view().status.message).toContain("Another writer");
  expect(controller.view().body[0]?.value).toBe("false");
  controller.handleInput(key.escape);
  expect(controller.view().closed).toBe(false);
  a.setRead(read(false, "new-baseline"));
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes[1]).toMatchObject({ expectedRevision: "new-baseline" });
  controller.dispose();
});

test("backend timeout is bounded and indeterminate; late success does not replace it; retry first performs read-back", async () => {
  const a = fixture();
  const outcome = deferred<EditResult>();
  a.row.write = async (transaction) => {
    a.writes.push(transaction);
    return outcome.promise;
  };
  const { controller } = center([a.row], 5);
  await tick();
  controller.handleInput(key.enter);
  await tick();
  await Bun.sleep(15);
  expect(controller.view().pending).toBe(false);
  expect(controller.view().status).toMatchObject({
    kind: "indeterminate",
    requiresAcknowledgement: true,
  });
  outcome.resolve(persisted(true));
  await tick();
  expect(controller.view().status.kind).toBe("indeterminate");
  expect(controller.view().body[0]?.value).toBe("false");
  controller.handleInput(key.enter);
  a.setRead(read(true, "read-back-revision"));
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes).toHaveLength(1);
  expect(controller.view().status.message).toContain("Read-back completed");
  expect(controller.view().body[0]?.value).toBe("true");
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes[1]).toMatchObject({
    expectedRevision: "read-back-revision",
    value: false,
  });
  controller.dispose();
});

test("activation outcomes are separate acknowledged saved states, with no raw activation errors", async () => {
  for (const activation of [
    { state: "active" },
    { state: "required", requirement: "restart" },
    {
      state: "failed",
      requirement: "immediate",
      message: "synthetic-private-activation",
    },
  ] satisfies ActivationResult[]) {
    const a = fixture();
    a.row.write = async () => persisted(true, activation);
    const { controller } = center([a.row]);
    await tick();
    controller.handleInput(key.enter);
    await tick();
    expect(controller.view().status.kind).toBe("saved");
    expect(controller.view().body[0]?.value).toBe("true");
    if (activation.state === "active")
      expect(controller.view().status.message).toContain("active");
    if (activation.state === "required")
      expect(controller.view().status.message).toContain("restart required");
    if (activation.state === "failed")
      expect(controller.view().status.message).toContain(
        "Saved but not active",
      );
    expect(JSON.stringify(controller.view())).not.toContain(
      "synthetic-private-activation",
    );
    controller.dispose();
  }
});

test("delete is a distinct visible confirmation action with the captured baseline revision", async () => {
  const a = fixture();
  const deletions: string[] = [];
  a.row.delete = async (scope, revision) => {
    deletions.push(`${scope}:${revision}`);
    return persisted(false);
  };
  const { controller } = center([a.row]);
  await tick();
  moveTo(controller, (entry) => entry.kind === "delete");
  controller.handleInput(key.enter);
  await tick();
  expect(controller.view().editor?.lines[1]?.label).toBe("Confirm deletion");
  expect(deletions).toHaveLength(0);
  controller.handleInput(key.escape);
  expect(deletions).toHaveLength(0);
  controller.handleInput(key.enter);
  await tick();
  controller.handleInput(key.down);
  controller.handleInput(key.enter);
  await tick();
  expect(deletions).toEqual(["user:r1"]);
  expect(a.writes).toHaveLength(0);
  controller.dispose();
});

test("late reads are guarded on navigation, withdrawal, replaced rows, and disposal", async () => {
  const a = fixture("a");
  const late = deferred<ScopedReadResult>();
  a.row.read = async () => late.promise;
  const b = fixture("b", "Appearance");
  const state = center([a.row, b.row]);
  state.controller.handleInput(key.enter);
  state.controller.handleInput(key.right);
  await tick();
  late.resolve(read(true, "late"));
  await tick();
  expect(a.writes).toHaveLength(0);
  expect(state.controller.view().tab).toBe("Appearance");
  expect(state.controller.view().editor).toBeNull();
  state.controller.handleInput(key.left);
  state.controller.handleInput(key.enter);
  state.controller.setRows([b.row]);
  await tick();
  expect(a.writes).toHaveLength(0);
  state.controller.dispose();
  const changes = state.changes();
  state.controller.handleInput(key.enter);
  state.controller.setRows([a.row]);
  expect(state.changes()).toBe(changes);
});

test("registry withdrawal cancels incomplete editors and never creates stale writes; dispatched saves still settle", async () => {
  const a = fixture("editable", "General", "existing", { kind: "text" });
  const state = center([a.row]);
  await tick();
  state.controller.handleInput(key.enter);
  await tick();
  state.controller.handleInput("unfinished");
  state.controller.setRows([]);
  expect(state.controller.view().editor).toBeNull();
  state.controller.handleInput(key.enter);
  expect(a.writes).toHaveLength(0);
  state.controller.setRows([a.row]);
  await tick();
  const saving = deferred<EditResult>();
  a.row.write = async (transaction) => {
    a.writes.push(transaction);
    return saving.promise;
  };
  state.controller.handleInput(key.enter);
  await tick();
  replaceText(state.controller, "saved-value");
  state.controller.handleInput(key.enter);
  await tick();
  expect(a.writes).toHaveLength(1);
  state.controller.setRows([]);
  state.controller.handleInput(key.escape);
  expect(state.closes()).toBe(0);
  saving.resolve({ state: "failed", message: "synthetic-secret" });
  await tick();
  expect(state.controller.view().status.requiresAcknowledgement).toBe(true);
  expect(state.closes()).toBe(0);
  state.controller.handleInput(key.enter);
  expect(state.closes()).toBe(1);
  state.controller.dispose();
});

test("disposal does not stop tracking already-dispatched promises, but suppresses callbacks and new input", async () => {
  const a = fixture();
  const saving = deferred<EditResult>();
  a.row.write = async () => saving.promise;
  const state = center([a.row]);
  await tick();
  state.controller.handleInput(key.enter);
  await tick();
  expect(state.controller.view().pending).toBe(true);
  state.controller.dispose();
  state.controller.dispose();
  const changes = state.changes();
  saving.resolve(persisted(true));
  await tick();
  expect(state.controller.view().pending).toBe(false);
  expect(state.changes()).toBe(changes);
  expect(state.closes()).toBe(0);
});

test("read errors are isolated and safe; Kitty input is routed without release events", async () => {
  const a = fixture();
  a.row.read = async () => {
    throw new Error("synthetic-read-secret");
  };
  const b = fixture("other", "Appearance");
  const { controller } = center([a.row, b.row]);
  await tick();
  expect(controller.view().status.kind).toBe("failure");
  expect(JSON.stringify(controller.view())).not.toContain(
    "synthetic-read-secret",
  );
  controller.handleInput(key.right);
  await tick();
  expect(controller.view().status.kind).not.toBe("failure");
  controller.handleInput("\x1b[111u");
  expect(controller.view().query).toBe("o");
  controller.handleInput("\x1b[111;1:3u");
  expect(controller.view().query).toBe("o");
  controller.handleInput("\x03");
  expect(controller.view().query).toBe("o");
  controller.dispose();
});

test("search keystrokes never invoke row reads; fresh baseline stays fixed throughout editing", async () => {
  const a = fixture("alpha", "General", "start", { kind: "text" });
  const { controller } = center([a.row]);
  await tick();
  const before = a.reads.length;
  for (const char of "alpha") {
    controller.handleInput(char);
    await tick();
  }
  controller.handleInput(key.right);
  controller.handleInput(key.left);
  controller.handleInput(key.backspace);
  await tick();
  expect(a.reads.length).toBe(before);
  controller.handleInput(key.enter);
  await tick();
  a.setRead(read("external", "external-revision"));
  replaceText(controller, "edited");
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes[0]).toMatchObject({
    expectedRevision: "r1",
    value: "edited",
  });
  controller.dispose();
});

test("absent sensitive override creates a hidden replacement instead of retaining an inherited credential", async () => {
  const a = fixture("credential", "General", "inherited-synthetic-secret", {
    kind: "text",
  });
  a.row.descriptor.sensitivity = "masked";
  a.row.read = async () => ({
    ...read("inherited-synthetic-secret"),
    configured: { present: false },
  });
  const { controller } = center([a.row]);
  await tick();
  controller.handleInput(key.enter);
  await tick();
  expect(controller.view().editor?.input).toBe("[hidden draft]");
  expect(
    controller
      .view()
      .editor?.lines.some((line) => line.label.includes("Retain")),
  ).toBe(false);
  controller.handleInput("new-synthetic-secret");
  expect(JSON.stringify(controller.view())).not.toContain(
    "new-synthetic-secret",
  );
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes[0]).toMatchObject({ value: "new-synthetic-secret" });
  controller.dispose();
});

test("removed row cannot dispatch a deferred baseline toggle or a completed editor's not-yet-called write", async () => {
  const a = fixture();
  const baseline = deferred<ScopedReadResult>();
  a.row.read = async () => baseline.promise;
  const { controller } = center([a.row]);
  controller.handleInput(key.enter);
  controller.setRows([]);
  baseline.resolve(read(false));
  await tick();
  expect(a.writes).toHaveLength(0);
  controller.dispose();
  const text = fixture("editable", "General", "old", { kind: "text" });
  const state = center([text.row]);
  await tick();
  state.controller.handleInput(key.enter);
  await tick();
  replaceText(state.controller, "new");
  state.controller.handleInput(key.enter);
  state.controller.setRows([]);
  await tick();
  expect(text.writes).toHaveLength(0);
  expect(state.controller.view().status.requiresAcknowledgement).toBe(true);
  state.controller.dispose();
});

test("view separates configured/effective values, inheritance source and unknown session state", async () => {
  const a = fixture(
    "scoped",
    "General",
    { local: true },
    { kind: "map", value: { kind: "boolean" } },
  );
  a.row.read = async (scope) => ({
    ...read({ local: true }),
    scope,
    effective: { known: true, value: { local: true, inherited: true } },
    provenance: { source: "user", sessionState: "unknown" },
  });
  const { controller } = center([a.row]);
  await tick();
  expect(controller.view().body[0]).toMatchObject({
    configured: { present: true, value: '{"local":true}' },
    effective: { known: true, value: '{"local":true,"inherited":true}' },
    provenance: { source: "user", sessionState: "unknown" },
  });
  expect(controller.view().help).toContain("Configured:");
  expect(controller.view().help).toContain("Effective:");
  expect(controller.view().help).toContain(
    "persisted settings are not necessarily active",
  );
  moveTo(
    controller,
    (entry) => entry.kind === "scope" && entry.scope === "project",
  );
  expect(selected(controller)?.configured).toBeNull();
  controller.dispose();
});

test("keybinding conflict warnings appear before save and require explicit acknowledgement", async () => {
  const a = fixture("binding", "Keybindings", "ctrl+a", {
    kind: "union",
    variants: [{ kind: "text" }, { kind: "list", item: { kind: "text" } }],
  });
  a.row.keyCapture = true;
  const warnings: EditTransaction[] = [];
  a.row.warnings = async (transaction) => {
    warnings.push(transaction);
    return ["Potential overlap with action. Context-dependent."];
  };
  const { controller } = center([a.row]);
  controller.handleInput("binding");
  controller.handleInput(key.enter);
  await tick();
  editorAction(controller, "Record one key");
  controller.handleInput("\x03");
  controller.handleInput(key.enter);
  await tick();
  expect(warnings[0]).toMatchObject({
    value: "ctrl+c",
    expectedRevision: "r1",
  });
  expect(a.writes).toHaveLength(0);
  expect(controller.view().editor?.lines[1]?.label).toBe(
    "Save despite warnings",
  );
  expect(controller.view().status.message).toContain(
    "legitimate across host contexts",
  );
  controller.handleInput(key.down);
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes[0]).toMatchObject({
    value: "ctrl+c",
    expectedRevision: "r1",
  });
  controller.dispose();
});

test("warning cancellation, withdrawal, and callback errors never dispatch an assignment", async () => {
  const a = fixture("binding", "General", "ctrl+a", { kind: "text" });
  const outcome = deferred<readonly string[]>();
  a.row.warnings = async () => outcome.promise;
  const { controller } = center([a.row]);
  await tick();
  controller.handleInput(key.enter);
  await tick();
  replaceText(controller, "ctrl+c");
  controller.handleInput(key.enter);
  await tick();
  controller.handleInput(key.escape);
  outcome.resolve(["synthetic-sensitive-warning"]);
  await tick();
  expect(a.writes).toHaveLength(0);
  expect(JSON.stringify(controller.view())).not.toContain(
    "synthetic-sensitive-warning",
  );
  a.row.warnings = async () => {
    throw new Error("synthetic-sensitive-error");
  };
  controller.handleInput(key.enter);
  await tick();
  replaceText(controller, "ctrl+c");
  controller.handleInput(key.enter);
  await tick();
  expect(controller.view().status.requiresAcknowledgement).toBe(true);
  expect(a.writes).toHaveLength(0);
  expect(JSON.stringify(controller.view())).not.toContain(
    "synthetic-sensitive-error",
  );
  controller.handleInput(key.enter);
  a.row.warnings = async () => ["context-dependent"];
  controller.handleInput(key.enter);
  await tick();
  replaceText(controller, "ctrl+c");
  controller.handleInput(key.enter);
  await tick();
  controller.setRows([]);
  controller.handleInput(key.enter);
  expect(a.writes).toHaveLength(0);
  controller.dispose();
});

test("extension source grouping takes precedence over a plugin page named General", async () => {
  const a = fixture("plugin-general", "General");
  a.row.descriptor.sourceLabel = "Extensions / Plugin / General";
  const { controller } = center([a.row]);
  await tick();
  expect(controller.view().empty).toBe(true);
  controller.handleInput(key.left);
  expect(controller.view().tab).toBe("Extensions");
  expect(controller.view().body[0]?.descriptorId).toBe("plugin-general");
  controller.dispose();
});

test("one browse/search arrow moves exactly one setting and clamps without touching actions", async () => {
  const rows = [
    fixture("item-a"),
    fixture("item-b"),
    fixture("item-c"),
  ] as const;
  rows[0].row.removeOverride = async () => persisted(false);
  rows[1].row.delete = async () => persisted(false);
  const { controller } = center(rows.map((item) => item.row));
  await tick();
  for (const query of ["", "item"]) {
    if (query) controller.handleInput(query);
    expect(selected(controller)?.descriptorId).toBe("item-a");
    controller.handleInput(key.up);
    expect(selected(controller)?.descriptorId).toBe("item-a");
    controller.handleInput(key.down);
    expect(selected(controller)?.descriptorId).toBe("item-b");
    controller.handleInput(key.down);
    expect(selected(controller)?.descriptorId).toBe("item-c");
    controller.handleInput(key.down);
    expect(selected(controller)?.descriptorId).toBe("item-c");
    controller.handleInput(key.up);
    expect(selected(controller)?.descriptorId).toBe("item-b");
    controller.handleInput(key.up);
    expect(selected(controller)?.descriptorId).toBe("item-a");
    expect(selected(controller)?.kind).toBe("setting");
  }
  expect(rows.flatMap((item) => item.writes)).toEqual([]);
  controller.dispose();
});

test("Tab actions stay with the descriptor, return before query-clear/close, and navigation never writes", async () => {
  const a = fixture("item-a");
  const b = fixture("item-b");
  a.row.removeOverride = async (transaction) => {
    a.writes.push(transaction);
    return persisted(false);
  };
  a.row.delete = async () => persisted(false);
  const { controller } = center([a.row, b.row]);
  await tick();
  controller.handleInput("item");
  controller.handleInput(key.tab);
  expect(controller.view().navigationMode).toBe("actions");
  expect(selected(controller)).toMatchObject({ kind: "scope", scope: "user" });
  controller.handleInput(key.up);
  expect(selected(controller)?.scope).toBe("user");
  for (const kind of ["scope", "reset", "delete", "delete"] as const) {
    controller.handleInput(key.down);
    expect(selected(controller)?.kind).toBe(kind);
    expect(selected(controller)?.descriptorId).toBe("item-a");
  }
  expect(a.writes).toEqual([]);
  controller.handleInput(key.escape);
  expect(controller.view()).toMatchObject({
    navigationMode: "settings",
    query: "item",
    closed: false,
  });
  expect(selected(controller)?.descriptorId).toBe("item-a");
  expect(selected(controller)?.kind).toBe("setting");
  controller.handleInput(key.down);
  controller.handleInput(key.tab);
  controller.handleInput(key.tab);
  expect(selected(controller)).toMatchObject({
    kind: "setting",
    descriptorId: "item-b",
  });
  controller.handleInput(key.escape);
  expect(controller.view().query).toBe("");
  expect(controller.view().closed).toBe(false);
  controller.handleInput(key.escape);
  expect(controller.view().closed).toBe(true);
  controller.dispose();
});

test("tab arrows, typing, and backspace leave actions while retaining browse selections", async () => {
  const a = fixture("item-a");
  const b = fixture("item-b");
  const other = fixture("other", "Appearance");
  const { controller } = center([a.row, b.row, other.row]);
  await tick();
  controller.handleInput(key.down);
  controller.handleInput(key.tab);
  controller.handleInput(key.right);
  expect(controller.view()).toMatchObject({
    navigationMode: "settings",
    tab: "Appearance",
  });
  controller.handleInput(key.left);
  expect(selected(controller)?.descriptorId).toBe("item-b");
  controller.handleInput(key.tab);
  controller.handleInput("item");
  expect(controller.view()).toMatchObject({
    navigationMode: "settings",
    query: "item",
  });
  controller.handleInput(key.escape);
  expect(selected(controller)?.descriptorId).toBe("item-b");
  controller.handleInput(key.tab);
  controller.handleInput(key.backspace);
  expect(controller.view()).toMatchObject({
    navigationMode: "settings",
    query: "",
  });
  expect(selected(controller)?.descriptorId).toBe("item-b");
  expect(a.writes.concat(b.writes, other.writes)).toEqual([]);
  controller.dispose();
});

test("all catalog rows preload before selection with at most four concurrent background callbacks", async () => {
  let active = 0;
  let peak = 0;
  let reads = 0;
  const waits = Array.from({ length: 11 }, () => deferred<ScopedReadResult>());
  const fixtures = waits.map((wait, index) => {
    const item = fixture(
      `preload-${index}`,
      index === 10 ? "Appearance" : "General",
      index,
    );
    item.row.read = async (scope) => {
      reads++;
      active++;
      peak = Math.max(peak, active);
      const result = await wait.promise;
      active--;
      return { ...result, scope };
    };
    return item;
  });
  const state = center(
    fixtures.map((item) => item.row),
    1000,
  );
  await tick();
  expect(reads).toBe(4);
  expect(peak).toBe(4);
  expect(
    state.controller
      .view()
      .body.filter((entry) => entry.kind === "setting")
      .every((entry) => entry.readState === "loading"),
  ).toBe(true);
  for (let start = 0; start < waits.length; start += 4) {
    for (
      let index = start;
      index < Math.min(start + 4, waits.length);
      index++
    ) {
      const wait = waits[index];
      if (!wait) throw new Error("Missing queued-read fixture.");
      wait.resolve(read(index));
    }
    await tick();
  }
  expect(reads).toBe(11);
  expect(peak).toBe(4);
  expect(selected(state.controller)?.descriptorId).toBe("preload-0");
  expect(
    state.controller
      .view()
      .body.filter((entry) => entry.kind === "setting")
      .map((entry) => [entry.readState, entry.value]),
  ).toEqual(Array.from({ length: 10 }, (_, i) => ["available", String(i)]));
  state.controller.handleInput(key.right);
  expect(selected(state.controller)).toMatchObject({
    descriptorId: "preload-10",
    readState: "available",
    value: "10",
  });
  expect(reads).toBe(11);
  expect(state.changes()).toBeLessThanOrEqual(15);
  state.controller.dispose();
});

test("settled preload cache survives stable refresh and all search/backspace keys without new reads", async () => {
  const fixtures = Array.from({ length: 9 }, (_, i) => fixture(`item-${i}`));
  const rows = fixtures.map((item) => item.row);
  const { controller } = center(rows);
  for (let i = 0; i < 4; i++) await tick();
  const counts = () => fixtures.map((item) => item.reads.length);
  expect(counts()).toEqual(Array(9).fill(1));
  for (const char of "item-2") controller.handleInput(char);
  for (let i = 0; i < 6; i++) controller.handleInput(key.backspace);
  controller.handleInput("item");
  controller.handleInput(key.down);
  controller.handleInput(key.up);
  controller.handleInput(key.escape);
  for (let i = 0; i < 5; i++) controller.setRows(rows);
  await tick();
  expect(counts()).toEqual(Array(9).fill(1));
  const added = fixture("added");
  controller.setRows([...rows, added.row]);
  await tick();
  expect(added.reads).toEqual(["user"]);
  expect(counts()).toEqual(Array(9).fill(1));
  controller.dispose();
});

test("background unavailable/error/unknown and secret outcomes are cached safely without foreground failures", async () => {
  const good = fixture("good");
  const unavailable = fixture("unavailable");
  unavailable.row.descriptor.scopes = ["project"];
  const errors = fixture("errors");
  const secret = fixture("secret", "General", "synthetic-hidden", {
    kind: "text",
  });
  secret.row.descriptor.sensitivity = "masked";
  const unknown = fixture("unknown");
  let failures = 0;
  unavailable.row.read = async (scope) => {
    failures++;
    return {
      state: "unavailable",
      scope,
      reason: "untrusted synthetic-unavailable-secret",
    };
  };
  errors.row.read = async (scope) => {
    failures++;
    return { state: "error", scope, message: "synthetic-error-secret" };
  };
  unknown.row.read = async () => ({
    ...read(false),
    configured: { present: false },
    effective: { known: false },
  });
  const rows = [good.row, unavailable.row, errors.row, secret.row, unknown.row];
  const { controller } = center(rows);
  for (let i = 0; i < 3; i++) await tick();
  expect(controller.view().status.kind).toBe("idle");
  expect(
    controller
      .view()
      .body.filter((entry) => entry.kind === "setting")
      .map((entry) => entry.readState),
  ).toEqual(["available", "unavailable", "error", "available", "available"]);
  expect(
    controller
      .view()
      .body.find(
        (entry) => entry.descriptorId === "unknown" && entry.kind === "setting",
      ),
  ).toMatchObject({
    value: null,
    configured: { present: false, value: null },
    effective: { known: false, value: null },
  });
  expect(JSON.stringify(controller.view())).not.toContain("synthetic-");
  controller.handleInput(key.down);
  expect(controller.view().status).toMatchObject({ kind: "unavailable" });
  expect(controller.view().status.message).toContain("not trusted");
  controller.handleInput(key.down);
  expect(controller.view().status.kind).toBe("failure");
  for (let i = 0; i < 5; i++) controller.setRows(rows);
  await tick();
  expect(failures).toBe(2);
  controller.dispose();
});

test("slow old preload cannot overwrite a fresh editor baseline or newer save acknowledgement", async () => {
  const a = fixture("text", "General", "new-baseline", { kind: "text" });
  const old = deferred<ScopedReadResult>();
  const saved = deferred<EditResult>();
  let reads = 0;
  a.row.read = async () =>
    ++reads === 1 ? old.promise : read("new-baseline", "fresh-revision");
  a.row.write = async (transaction) => {
    a.writes.push(transaction);
    return saved.promise;
  };
  const { controller } = center([a.row], 1000);
  await tick();
  controller.handleInput(key.enter);
  await tick();
  expect(reads).toBe(2);
  expect(controller.view().editor?.input).toBe("new-baseline");
  replaceText(controller, "saved-new");
  controller.handleInput(key.enter);
  await tick();
  expect(a.writes[0]).toMatchObject({
    expectedRevision: "fresh-revision",
    value: "saved-new",
  });
  saved.resolve(persisted("saved-new"));
  await tick();
  expect(controller.view().body[0]?.value).toBe('"saved-new"');
  old.resolve(read("stale-old", "old-revision"));
  await tick();
  expect(controller.view().body[0]?.value).toBe('"saved-new"');
  expect(controller.view().status.kind).toBe("saved");
  controller.setRows([a.row]);
  await tick();
  expect(reads).toBe(2);
  expect(controller.view().status.kind).toBe("saved");
  controller.handleInput(key.enter);
  await tick();
  expect(reads).toBe(3);
  controller.dispose();
});

test("scope changes and navigation do not confuse independent per-key preloads", async () => {
  const a = fixture("a");
  const b = fixture("b");
  const old = deferred<ScopedReadResult>();
  const other = deferred<ScopedReadResult>();
  a.row.read = async (scope) =>
    scope === "user" ? old.promise : { ...read(true, "project-r1"), scope };
  b.row.read = async () => other.promise;
  const { controller } = center([a.row, b.row], 1000);
  await tick();
  controller.handleInput(key.tab);
  controller.handleInput(key.down);
  controller.handleInput(key.enter);
  await tick();
  expect(selected(controller)).toMatchObject({
    kind: "scope",
    scope: "project",
    readState: "available",
  });
  controller.handleInput(key.tab);
  controller.handleInput(key.down);
  old.resolve(read(false, "user-old"));
  other.resolve(read(true));
  await tick();
  expect(
    controller
      .view()
      .body.find(
        (entry) => entry.descriptorId === "a" && entry.kind === "setting",
      ),
  ).toMatchObject({ scope: "project", value: "true", readState: "available" });
  expect(selected(controller)).toMatchObject({
    descriptorId: "b",
    value: "true",
    readState: "available",
  });
  controller.dispose();
});

test("refresh replacement/withdrawal guards late preloads and stable refresh never multiplies queued work", async () => {
  const waits = Array.from({ length: 7 }, () => deferred<ScopedReadResult>());
  let reads = 0;
  const rows = waits.map((wait, i) => {
    const a = fixture(`item-${i}`);
    a.row.read = async () => {
      reads++;
      return wait.promise;
    };
    return a.row;
  });
  const { controller } = center(rows, 1000);
  await tick();
  expect(reads).toBe(4);
  for (let i = 0; i < 10; i++) controller.setRows(rows);
  await tick();
  expect(reads).toBe(4);
  const replacement = fixture("item-0", "General", true);
  const retained = rows[1];
  if (!retained) throw new Error("Missing retained row fixture.");
  controller.setRows([replacement.row, retained]);
  for (const wait of waits) wait.resolve(read(false, "old"));
  for (let i = 0; i < 3; i++) await tick();
  expect(reads).toBe(4);
  expect(replacement.reads).toEqual(["user"]);
  expect(
    controller
      .view()
      .body.filter((entry) => entry.kind === "setting")
      .map((entry) => entry.value),
  ).toEqual(["true", "false"]);
  controller.setRows([replacement.row, retained]);
  await tick();
  expect(replacement.reads).toHaveLength(1);
  controller.dispose();
});

test("disposal and normal close suppress all late preload notifications and prevent queue dispatch", async () => {
  for (const close of [false, true]) {
    const waits = Array.from({ length: 8 }, () => deferred<ScopedReadResult>());
    let reads = 0;
    const rows = waits.map((wait, i) => {
      const a = fixture(`item-${i}`);
      a.row.read = async () => {
        reads++;
        return wait.promise;
      };
      return a.row;
    });
    const state = center(rows, 1000);
    await tick();
    expect(reads).toBe(4);
    if (close) state.controller.handleInput(key.escape);
    else state.controller.dispose();
    const notifications = state.changes();
    for (const wait of waits) wait.resolve(read(true));
    await tick();
    expect(reads).toBe(4);
    expect(state.changes()).toBe(notifications);
    expect(state.closes()).toBe(close ? 1 : 0);
    state.controller.dispose();
  }
});

test("suggestion preparation retains the row receiver and hanging metadata falls back within its deadline", async () => {
  const a = fixture("model", "General", "custom-id", { kind: "text" });
  a.row.editorSuggestions = async function (this: CenterRow) {
    expect(this).toBe(a.row);
    return () => [{ value: "model-id", label: "Known model" }];
  };
  const first = center([a.row]);
  first.controller.handleInput(key.enter);
  await tick();
  expect(first.controller.view().editor?.picking).toBe(true);
  first.controller.dispose();
  const hanging = deferred<import("../src/editors.ts").EditorSuggestions>();
  a.row.editorSuggestions = async () => hanging.promise;
  const second = center([a.row], 5);
  second.controller.handleInput(key.enter);
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(second.controller.view().editor?.input).toBe("custom-id");
  expect(second.controller.view().editor?.picking).toBeUndefined();
  hanging.resolve(() => [{ value: "late", label: "Late model" }]);
  await tick();
  expect(second.controller.view().editor?.input).toBe("custom-id");
  expect(a.writes).toEqual([]);
  second.controller.dispose();
});

test("late suggestion factories cannot open stale editors after navigation, withdrawal or disposal", async () => {
  for (const change of ["navigate", "withdraw", "dispose"] as const) {
    const a = fixture("model", "General", "old", { kind: "text" });
    const b = fixture("next");
    const waiting = deferred<import("../src/editors.ts").EditorSuggestions>();
    let calls = 0;
    a.row.editorSuggestions = async () => {
      calls++;
      return waiting.promise;
    };
    const { controller } = center([a.row, b.row], 1000);
    await tick();
    controller.handleInput(key.enter);
    await tick();
    expect(calls).toBe(1);
    if (change === "navigate") controller.handleInput(key.down);
    else if (change === "withdraw") controller.setRows([b.row]);
    else controller.dispose();
    waiting.resolve(() => [{ value: "new", label: "New model" }]);
    await tick();
    expect(controller.view().editor).toBeNull();
    expect(a.writes).toEqual([]);
    controller.dispose();
  }
});

test("failed suggestion preparation falls back to typed editing with safe diagnostics", async () => {
  const a = fixture("model", "General", "custom-id", { kind: "text" });
  a.row.editorSuggestions = async () => {
    throw new Error("private diagnostic");
  };
  const { controller } = center([a.row]);
  controller.handleInput(key.enter);
  await tick();
  expect(controller.view().editor?.input).toBe("custom-id");
  expect(JSON.stringify(controller.view())).not.toContain("private diagnostic");
  controller.handleInput(key.escape);
  expect(a.writes).toEqual([]);
  controller.dispose();
});

test("typing/backspace never schedules a missing current-scope read after cancelling fresh activation", async () => {
  const a = fixture("alpha");
  const project = deferred<ScopedReadResult>();
  a.row.read = async (scope) => {
    a.reads.push(scope);
    return scope === "project" ? project.promise : read(false);
  };
  const { controller } = center([a.row], 1000);
  await tick();
  controller.handleInput(key.tab);
  controller.handleInput(key.down);
  controller.handleInput(key.enter);
  await tick();
  expect(a.reads).toEqual(["user", "project"]);
  controller.handleInput("a");
  controller.handleInput(key.backspace);
  controller.handleInput(key.backspace);
  await tick();
  expect(controller.view()).toMatchObject({
    navigationMode: "settings",
    query: "",
  });
  expect(a.reads).toEqual(["user", "project"]);
  project.resolve({ ...read(true), scope: "project" });
  await tick();
  expect(a.reads).toEqual(["user", "project"]);
  controller.dispose();
});
