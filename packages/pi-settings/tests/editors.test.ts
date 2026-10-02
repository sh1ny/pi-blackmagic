import { expect, test } from "bun:test";
import type { JsonValue, ValueSchema } from "../src/contracts.ts";
import {
  editorDefault,
  editorDisplayValue,
  type EditorSuggestionContext,
  type EditorSuggestions,
  printableInput,
  safeEditorValue,
  TypedEditor,
  validEditorDraft,
} from "../src/editors.ts";
import { isMasked, maskValue, restoreMasked } from "../src/redaction.ts";

const key = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  home: "\x1b[H",
  end: "\x1b[F",
};
function select(editor: TypedEditor, label: string) {
  const index = editor
    .view()
    .lines.findIndex((line) => line.label.startsWith(label));
  expect(index).toBeGreaterThanOrEqual(0);
  while (editor.view().selected < index) editor.handleInput(key.down);
  while (editor.view().selected > index) editor.handleInput(key.up);
  return editor.handleInput(key.enter);
}
function text(editor: TypedEditor, replacement: string) {
  editor.handleInput(key.end);
  for (let i = 0; i < 100; i++) editor.handleInput(key.backspace);
  editor.handleInput(replacement);
}
const structure: ValueSchema = {
  kind: "structured",
  preserveUnknown: true,
  fields: {
    name: {
      schema: { kind: "text", minLength: 1 },
      required: true,
      sensitivity: "public",
      description: "A required service name.",
    },
    token: {
      schema: { kind: "text" },
      required: false,
      sensitivity: "masked",
      description: "Optional credential.",
    },
    enabled: {
      schema: { kind: "boolean" },
      required: false,
      sensitivity: "public",
      description: "Enable the service.",
    },
    ports: {
      schema: {
        kind: "list",
        item: { kind: "number", minimum: 1, integer: true },
      },
      required: false,
      sensitivity: "public",
      description: "Local port numbers.",
    },
  },
};

test("scalar editors validate text/numbers, own cursor arrows, and accept boolean/choice", () => {
  const editor = new TypedEditor(
    { kind: "text", minLength: 2, maxLength: 5 },
    "ab",
  );
  editor.handleInput(key.left);
  editor.handleInput("c");
  expect(editor.view().input).toBe("acb");
  expect(editor.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "acb",
  });
  const invalid = new TypedEditor(
    { kind: "number", minimum: 1, maximum: 10, integer: true },
    2,
  );
  text(invalid, "1.5");
  expect(invalid.handleInput(key.enter).state).toBe("editing");
  expect(invalid.view().message).toContain("schema");
  text(invalid, "9");
  expect(invalid.handleInput(key.enter)).toEqual({
    state: "complete",
    value: 9,
  });
  const emptyNumber = new TypedEditor({ kind: "number" }, 0);
  text(emptyNumber, "");
  expect(emptyNumber.handleInput(key.enter).state).toBe("editing");
  const toggle = new TypedEditor({ kind: "boolean" }, false);
  toggle.handleInput(key.down);
  expect(toggle.handleInput(key.enter)).toEqual({
    state: "complete",
    value: true,
  });
  const choice = new TypedEditor(
    { kind: "choice", values: ["one", "two", null] },
    "one",
  );
  choice.handleInput(key.right);
  expect(choice.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "two",
  });
});

test("structured forms expose descriptions and absent fields, validate required fields, and complete atomically", () => {
  const editor = new TypedEditor(structure, {});
  expect(editor.view().lines[0]).toMatchObject({
    label: "name (required, absent)",
    description: "A required service name.",
  });
  expect(editor.view().lines[1]?.label).toContain("token (optional, absent)");
  expect(select(editor, "Complete entry").state).toBe("editing");
  select(editor, "name");
  editor.handleInput("local");
  expect(editor.handleInput(key.enter).state).toBe("editing");
  select(editor, "enabled");
  select(editor, "true");
  select(editor, "ports");
  select(editor, "Add item");
  text(editor, "8080");
  editor.handleInput(key.enter);
  select(editor, "Complete entry");
  const outcome = select(editor, "Complete entry");
  expect(outcome).toEqual({
    state: "complete",
    value: { name: "local", enabled: true, ports: [8080] },
  });
});

test("optional field removal, nested Back, and whole-entry Escape stay draft-local", () => {
  const original: JsonValue = {
    name: "local",
    enabled: true,
    futureField: "retain me",
  };
  const editor = new TypedEditor(structure, original);
  select(editor, "Remove enabled");
  select(editor, "name");
  text(editor, "unfinished");
  select(editor, "Back without");
  expect(select(editor, "Complete entry")).toMatchObject({
    state: "complete",
    value: {
      name: "local",
      futureField: { $piSettingsMasked: true, $token: expect.any(String) },
    },
  });
  expect(original).toEqual({
    name: "local",
    enabled: true,
    futureField: "retain me",
  });
  const cancel = new TypedEditor(structure, { name: "local" });
  select(cancel, "ports");
  select(cancel, "Add item");
  text(cancel, "9000");
  expect(cancel.handleInput(key.escape)).toEqual({ state: "cancelled" });
});

test("lists support typed add, edit, remove, and count constraints", () => {
  const editor = new TypedEditor(
    {
      kind: "list",
      item: { kind: "text", minLength: 1 },
      minItems: 1,
      maxItems: 2,
    },
    ["first"],
  );
  select(editor, "Edit item 1");
  text(editor, "edited");
  editor.handleInput(key.enter);
  select(editor, "Add item");
  editor.handleInput("second");
  editor.handleInput(key.enter);
  select(editor, "Remove item 1");
  expect(select(editor, "Complete entry")).toEqual({
    state: "complete",
    value: ["second"],
  });
  const empty = new TypedEditor(
    { kind: "list", item: { kind: "text" }, minItems: 1 },
    [],
  );
  expect(select(empty, "Complete entry").state).toBe("editing");
});

test("maps support add/edit/rename/remove, collision rejection, and safe prototype keys", () => {
  const editor = new TypedEditor(
    { kind: "map", value: { kind: "number", integer: true } },
    { old: 1, existing: 2 },
  );
  select(editor, "Rename old");
  text(editor, "existing");
  editor.handleInput(key.enter);
  expect(editor.view().message).toContain("already exists");
  text(editor, "new");
  editor.handleInput(key.enter);
  select(editor, "Edit new");
  text(editor, "3");
  editor.handleInput(key.enter);
  select(editor, "Remove existing");
  select(editor, "Add key");
  editor.handleInput("__proto__");
  editor.handleInput(key.enter);
  text(editor, "5");
  editor.handleInput(key.enter);
  const outcome = select(editor, "Complete entry");
  expect(outcome.state).toBe("complete");
  if (outcome.state === "complete") {
    expect(outcome.value).toEqual(JSON.parse('{"new":3,"__proto__":5}'));
    expect(Object.hasOwn(outcome.value as object, "__proto__")).toBe(true);
  }
});

test("union variants open typed editors; only unconstrained JSON uses JSON fallback", () => {
  const union: ValueSchema = {
    kind: "union",
    variants: [
      { kind: "text" },
      {
        kind: "structured",
        preserveUnknown: false,
        fields: {
          count: {
            schema: { kind: "number", integer: true },
            required: true,
            sensitivity: "public",
            description: "Item count.",
          },
        },
      },
    ],
  };
  const editor = new TypedEditor(union, "original");
  select(editor, "Variant 2");
  expect(editor.view().kind).toBe("structured");
  select(editor, "count");
  text(editor, "4");
  editor.handleInput(key.enter);
  select(editor, "Complete entry");
  expect(select(editor, "Complete entry")).toEqual({
    state: "complete",
    value: { count: 4 },
  });
  const json = new TypedEditor({ kind: "json" }, null);
  text(json, "{bad");
  expect(json.handleInput(key.enter).state).toBe("editing");
  expect(json.view().message).not.toContain("bad");
  text(json, '{"nested":[true]}');
  expect(json.handleInput(key.enter)).toEqual({
    state: "complete",
    value: { nested: [true] },
  });
  expect(editorDefault({ kind: "union", variants: [] })).toBe(null);
});

test("masked root and field values are retained without disclosure; replacement typing is hidden", () => {
  const sentinel = { $piSettingsMasked: true };
  const original = { name: "visible", token: "synthetic-original-secret" };
  const editor = new TypedEditor(structure, original);
  expect(JSON.stringify(editor.view())).not.toContain(
    "synthetic-original-secret",
  );
  select(editor, "token");
  expect(editor.view().lines[0]?.label).toBe("Retain masked value");
  select(editor, "Retain");
  expect(select(editor, "Complete entry")).toMatchObject({
    state: "complete",
    value: {
      name: "visible",
      token: { ...sentinel, $token: expect.any(String) },
    },
  });
  const replacement = new TypedEditor(structure, original);
  select(replacement, "token");
  select(replacement, "Replace");
  replacement.handleInput("synthetic-replacement-secret");
  expect(JSON.stringify(replacement.view())).not.toContain(
    "synthetic-replacement-secret",
  );
  expect(replacement.view().input).toBe("[hidden draft]");
  replacement.handleInput(key.enter);
  expect(select(replacement, "Complete entry")).toEqual({
    state: "complete",
    value: { name: "visible", token: "synthetic-replacement-secret" },
  });
  const root = new TypedEditor({ kind: "text" }, "synthetic-secret", {
    sensitivity: "masked",
  });
  select(root, "Replace");
  root.handleInput("new-root-secret");
  expect(JSON.stringify(root.view())).not.toContain("new-root-secret");
  expect(root.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "new-root-secret",
  });
  const empty = new TypedEditor({ kind: "text" }, sentinel);
  select(empty, "Replace");
  expect(empty.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "",
  });
});

test("absent sensitive fields can be added and typed public inputs remain visible", () => {
  const editor = new TypedEditor(structure, { name: "local" });
  select(editor, "token");
  editor.handleInput("new-sensitive");
  expect(editor.view().input).toBe("[hidden draft]");
  editor.handleInput(key.enter);
  expect(select(editor, "Complete entry")).toEqual({
    state: "complete",
    value: { name: "local", token: "new-sensitive" },
  });
  const root = new TypedEditor({ kind: "text" }, "", {
    sensitivity: "masked",
    existingValue: false,
  });
  root.handleInput("new-value");
  expect(root.view().input).toBe("[hidden draft]");
  expect(root.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "new-value",
  });
});

test("redaction is idempotent for backend sentinels, covers union fields, env and headers", () => {
  const sentinel = { $piSettingsMasked: true };
  expect(
    safeEditorValue(structure, {
      name: "local",
      token: sentinel,
      unknown: sentinel,
    }),
  ).toEqual({ name: "local", token: sentinel, unknown: sentinel });
  const union: ValueSchema = {
    kind: "union",
    variants: [structure, { kind: "text" }],
  };
  expect(
    safeEditorValue(union, { name: "local", token: "synthetic-sensitive" }),
  ).toMatchObject({
    name: "local",
    token: { ...sentinel, $token: expect.any(String) },
  });
  expect(
    safeEditorValue(
      { kind: "json" },
      {
        env: { TOKEN: "synthetic-sensitive" },
        headers: { Custom: "synthetic-sensitive" },
      },
    ),
  ).toMatchObject({
    env: { TOKEN: { ...sentinel, $token: expect.any(String) } },
    headers: { Custom: { ...sentinel, $token: expect.any(String) } },
  });
  const editor = new TypedEditor(
    { kind: "map", value: { kind: "text" } },
    { authorization: "synthetic-sensitive" },
  );
  select(editor, "Edit authorization");
  select(editor, "Replace");
  editor.handleInput("replacement-sensitive");
  expect(editor.view().input).toBe("[hidden draft]");
  expect(validEditorDraft({ kind: "text" }, sentinel, null)).toBe(false);
});

test("masked sentinels cannot be moved to another restore path accidentally", () => {
  const editor = new TypedEditor({ kind: "list", item: { kind: "text" } }, [
    "public",
    { $piSettingsMasked: true },
  ]);
  select(editor, "Remove item 1");
  expect(editor.view().message).toContain("positions");
  expect(select(editor, "Complete entry")).toEqual({
    state: "complete",
    value: ["public", { $piSettingsMasked: true }],
  });
  const map = new TypedEditor(
    { kind: "map", value: { kind: "text" } },
    { key: { $piSettingsMasked: true } },
  );
  select(map, "Rename key");
  expect(map.view().message).toContain("renaming");
});

test("keybinding capture requires separate confirmation and rejects unsupported plus assignments", () => {
  const editor = new TypedEditor(
    {
      kind: "union",
      variants: [{ kind: "text" }, { kind: "list", item: { kind: "text" } }],
    },
    "ctrl+a",
    { keyCapture: true },
  );
  select(editor, "Record one key");
  expect(editor.handleInput(key.right)).toEqual({ state: "editing" });
  expect(editor.view().lines[0]?.label).toContain("right");
  expect(editor.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "right",
  });
  const enter = new TypedEditor({ kind: "text" }, "", { keyCapture: true });
  select(enter, "Record one key");
  expect(enter.handleInput(key.enter).state).toBe("editing");
  expect(enter.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "enter",
  });
  const plus = new TypedEditor({ kind: "text" }, "", { keyCapture: true });
  select(plus, "Record one key");
  plus.handleInput("+");
  expect(plus.view().message).toContain("0.99.1");
  const cancel = new TypedEditor({ kind: "text" }, "", { keyCapture: true });
  select(cancel, "Record one key");
  cancel.handleInput("a");
  expect(cancel.handleInput(key.escape)).toEqual({ state: "cancelled" });
});

test("public Pi keyboard input handles Kitty printable and ignores release/control sequences", () => {
  expect(printableInput("\x1b[97u")).toBe("a");
  expect(printableInput("\x1b[97;5u")).toBeUndefined();
  expect(printableInput("\x1b[97;1:3u")).toBeUndefined();
  expect(printableInput("\x03")).toBeUndefined();
  const editor = new TypedEditor({ kind: "text" }, "");
  editor.handleInput("\x1b[97u");
  editor.handleInput("\x1b[C");
  editor.handleInput("🙂");
  editor.handleInput(key.backspace);
  expect(editor.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "a",
  });
});

test("opaque retention references survive list removal/reorder and map rename without rendering internals", () => {
  const schema: ValueSchema = {
    kind: "list",
    item: {
      kind: "structured",
      preserveUnknown: false,
      fields: {
        name: {
          schema: { kind: "text" },
          required: true,
          sensitivity: "public",
          description: "Name.",
        },
        token: {
          schema: { kind: "text" },
          required: true,
          sensitivity: "masked",
          description: "Credential.",
        },
      },
    },
  };
  const original: JsonValue = [
    { name: "first", token: "first-synthetic-secret" },
    { name: "second", token: "second-synthetic-secret" },
    { name: "third", token: "third-synthetic-secret" },
  ];
  const safe = maskValue(original, { schema, sensitivity: "public" });
  const editor = new TypedEditor(schema, safe);
  select(editor, "Remove item 1");
  select(editor, "Move item 2 up");
  expect(JSON.stringify(editor.view())).not.toContain("$token");
  const outcome = select(editor, "Complete entry");
  expect(outcome.state).toBe("complete");
  if (outcome.state === "complete") {
    expect(restoreMasked(outcome.value, original)).toEqual([
      { name: "third", token: "third-synthetic-secret" },
      { name: "second", token: "second-synthetic-secret" },
    ]);
    const marker = (
      (outcome.value as JsonValue[])[0] as Record<string, JsonValue>
    ).token as JsonValue;
    expect(isMasked(marker)).toBe(true);
    expect(editorDisplayValue(outcome.value)).not.toContain("$token");
  }
  const mapSchema: ValueSchema = { kind: "map", value: { kind: "text" } };
  const mapOriginal = { authorization: "synthetic-map-secret" };
  const mapSafe = maskValue(mapOriginal, {
    schema: mapSchema,
    sensitivity: "public",
  });
  const map = new TypedEditor(mapSchema, mapSafe);
  select(map, "Rename authorization");
  text(map, "renamed");
  map.handleInput(key.enter);
  const mapOutcome = select(map, "Complete entry");
  expect(mapOutcome.state).toBe("complete");
  if (mapOutcome.state === "complete") {
    expect((mapOutcome.value as Record<string, JsonValue>).renamed).toEqual(
      (mapSafe as Record<string, JsonValue>).authorization,
    );
    expect(restoreMasked(mapOutcome.value, mapOriginal)).toEqual({
      renamed: "synthetic-map-secret",
    });
  }
});

test("new environment/header values inherit hidden input ownership even when field map metadata is public", () => {
  const schema: ValueSchema = {
    kind: "structured",
    preserveUnknown: false,
    fields: {
      headers: {
        schema: { kind: "map", value: { kind: "text" } },
        required: false,
        sensitivity: "public",
        description: "Headers.",
      },
    },
  };
  const editor = new TypedEditor(schema, {});
  select(editor, "headers");
  select(editor, "Add key");
  editor.handleInput("Custom");
  editor.handleInput(key.enter);
  editor.handleInput("new-synthetic-header-secret");
  expect(editor.view().input).toBe("[hidden draft]");
  expect(JSON.stringify(editor.view())).not.toContain(
    "new-synthetic-header-secret",
  );
  editor.handleInput(key.enter);
  select(editor, "Complete entry");
  expect(select(editor, "Complete entry")).toEqual({
    state: "complete",
    value: { headers: { Custom: "new-synthetic-header-secret" } },
  });
});

test("capture mode preserves multiple assignment editing and explicit disabling", () => {
  const schema: ValueSchema = {
    kind: "union",
    variants: [{ kind: "text" }, { kind: "list", item: { kind: "text" } }],
  };
  const editor = new TypedEditor(schema, ["ctrl+a", "ctrl+b"], {
    keyCapture: true,
  });
  select(editor, "Edit assignment list");
  expect(editor.view().kind).toBe("list");
  select(editor, "Edit item 1");
  editor.handleInput("\x03");
  editor.handleInput(key.enter);
  select(editor, "Add item");
  editor.handleInput(key.right);
  editor.handleInput(key.enter);
  expect(select(editor, "Complete entry")).toEqual({
    state: "complete",
    value: ["ctrl+c", "ctrl+b", "right"],
  });
  const disable = new TypedEditor(schema, ["ctrl+a", "ctrl+b"], {
    keyCapture: true,
  });
  expect(select(disable, "Disable action")).toEqual({
    state: "complete",
    value: [],
  });
});

test("sensitivity survives replacing, renaming, and reopening an opaque masked map value", () => {
  const schema: ValueSchema = { kind: "map", value: { kind: "text" } };
  const original = { authorization: "old-synthetic-sensitive" };
  const editor = new TypedEditor(
    schema,
    maskValue(original, { schema, sensitivity: "public" }),
  );
  select(editor, "Edit authorization");
  select(editor, "Replace");
  editor.handleInput("new-synthetic-sensitive");
  editor.handleInput(key.enter);
  select(editor, "Rename authorization");
  text(editor, "ordinaryName");
  editor.handleInput(key.enter);
  select(editor, "Edit ordinaryName");
  expect(editor.view().input).toBe("[hidden draft]");
  expect(JSON.stringify(editor.view())).not.toContain(
    "new-synthetic-sensitive",
  );
});

test("new embedded URL credentials and unconstrained JSON credential fields are hidden while typing", () => {
  const url = new TypedEditor({ kind: "text" }, "https://example.test");
  text(url, "https://user:synthetic-url-secret@example.test");
  expect(url.view().input).toBe("[hidden draft]");
  expect(JSON.stringify(url.view())).not.toContain("synthetic-url-secret");
  const json = new TypedEditor({ kind: "json" }, null);
  text(json, '{"password":"synthetic-json-secret');
  expect(json.view().input).toBe("[hidden draft]");
  expect(JSON.stringify(json.view())).not.toContain("synthetic-json-secret");
});

const catalog: EditorSuggestions = () => [
  {
    value: "alpha/model",
    label: "Alpha Model",
    description: "Fast local choice",
  },
  { value: "beta/model", label: "Beta Model", description: "Reasoning choice" },
  { value: "gamma/model", label: "Gamma Model", description: "Vision choice" },
];

test("suggestion pickers search values, labels and descriptions and own selection/filter keys", () => {
  const editor = new TypedEditor({ kind: "text" }, "", {
    suggestions: catalog,
  });
  expect(editor.view()).toMatchObject({ kind: "text", input: "", cursor: 0 });
  expect(editor.view().help).toContain("Type to filter");
  expect(editor.view().help).toContain("Tab");
  editor.handleInput(key.down);
  expect(editor.view().lines[1]?.selected).toBe(true);
  editor.handleInput("vIsIoN");
  expect(editor.view().input).toBe("vIsIoN");
  expect(editor.view().lines.map((line) => line.label)).toEqual([
    "Gamma Model",
    "Enter custom value…",
  ]);
  for (let index = 0; index < 6; index++) editor.handleInput(key.backspace);
  editor.handleInput("BETA/MODEL");
  expect(editor.view().lines[0]?.label).toBe("Beta Model");
  text(editor, "Alpha Model");
  expect(editor.view().lines[0]?.label).toBe("Alpha Model");
  editor.handleInput(key.left);
  editor.handleInput("🙂");
  editor.handleInput(key.backspace);
  expect(editor.view().input).toBe("Alpha Model");
  expect(editor.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "alpha/model",
  });
});

test("suggestions select known current values and retain unlisted values on immediate confirmation", () => {
  const known = new TypedEditor({ kind: "text" }, "beta/model", {
    suggestions: catalog,
  });
  expect(known.view().selected).toBe(1);
  expect(known.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "beta/model",
  });
  const custom = new TypedEditor({ kind: "text" }, "my-provider/custom-*", {
    suggestions: catalog,
  });
  expect(custom.view().lines[0]).toMatchObject({
    label: "Keep current value: my-provider/custom-*",
    selected: true,
  });
  expect(custom.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "my-provider/custom-*",
  });
  const emptyCatalog = new TypedEditor({ kind: "text" }, "existing", {
    suggestions: () => [],
  });
  expect(emptyCatalog.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "existing",
  });
});

test("custom action and Tab preserve normal text editing and schema constraints", () => {
  const editor = new TypedEditor(
    { kind: "text", minLength: 2, maxLength: 20 },
    "beta/model",
    { suggestions: catalog },
  );
  select(editor, "Enter custom value");
  expect(editor.view().input).toBe("beta/model");
  expect(editor.view().help).toContain("custom value");
  text(editor, "x");
  expect(editor.handleInput(key.enter).state).toBe("editing");
  expect(editor.view().message).toContain("schema");
  text(editor, "private/model-*");
  editor.handleInput(key.tab);
  expect(editor.view().help).toContain("Type to filter");
  editor.handleInput(key.tab);
  expect(editor.view().input).toBe("private/model-*");
  expect(editor.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "private/model-*",
  });
  const empty = new TypedEditor({ kind: "text" }, "", {
    suggestions: () => [],
  });
  expect(empty.view().lines[0]?.label).toBe("Enter custom value…");
  empty.handleInput(key.enter);
  empty.handleInput("arbitrary-provider/id-*");
  expect(empty.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "arbitrary-provider/id-*",
  });
  const normal = new TypedEditor({ kind: "text" }, "normal", {
    suggestions: () => undefined,
  });
  expect(normal.view().input).toBe("normal");
  expect(normal.view().help).not.toContain("Tab");
});

test("suggestion commits still validate and structured initialField returns to the atomic root form", () => {
  const original = {};
  const contexts: EditorSuggestionContext[] = [];
  const editor = new TypedEditor(structure, original, {
    initialField: "name",
    existingValue: false,
    suggestions: (context) => {
      contexts.push(context);
      return [
        { value: "", label: "Invalid empty" },
        { value: "local", label: "Local provider" },
      ];
    },
  });
  expect(editor.view().path).toEqual(["name"]);
  expect(contexts[0]).toEqual({
    path: ["name"],
    rootValue: {},
    parentValue: {},
    currentValue: "",
  });
  expect(editor.handleInput(key.enter).state).toBe("editing");
  expect(editor.view().message).toContain("schema");
  select(editor, "Local provider");
  expect(editor.view().path).toEqual([]);
  expect(editor.view().kind).toBe("structured");
  expect(original).toEqual({});
  expect(select(editor, "Complete entry")).toEqual({
    state: "complete",
    value: { name: "local" },
  });
  expect(
    new TypedEditor(
      structure,
      {},
      { initialField: "unknown", suggestions: catalog },
    ).view().path,
  ).toEqual([]);
  expect(
    new TypedEditor({ kind: "text" }, "", {
      initialField: "name",
      suggestions: catalog,
    }).view().path,
  ).toEqual([]);
});

test("list text leaves and map key/value pickers use cloned local contexts and never mutate inputs", () => {
  const contexts: EditorSuggestionContext[] = [];
  const suggestions: EditorSuggestions = (context) => {
    contexts.push(structuredClone(context));
    (context.path as string[])[0] = "mutated";
    if (Array.isArray(context.rootValue)) context.rootValue.push("mutated");
    if (
      context.parentValue &&
      typeof context.parentValue === "object" &&
      !Array.isArray(context.parentValue)
    )
      context.parentValue.injected = "mutated";
    return catalog(context);
  };
  const original = ["alpha/model"];
  const list = new TypedEditor(
    { kind: "list", item: { kind: "text" } },
    original,
    { suggestions },
  );
  select(list, "Edit item 1");
  expect(contexts.at(-1)).toEqual({
    path: ["0"],
    rootValue: original,
    parentValue: original,
    currentValue: "alpha/model",
  });
  select(list, "Beta Model");
  select(list, "Add item");
  expect(contexts.at(-1)).toEqual({
    path: ["1"],
    rootValue: ["beta/model"],
    parentValue: ["beta/model"],
    currentValue: "",
  });
  select(list, "Gamma Model");
  expect(original).toEqual(["alpha/model"]);
  expect(select(list, "Complete entry")).toEqual({
    state: "complete",
    value: ["beta/model", "gamma/model"],
  });
  const mapOriginal = { old: "alpha/model" };
  const map = new TypedEditor(
    { kind: "map", value: { kind: "text" } },
    mapOriginal,
    { suggestions },
  );
  select(map, "Rename old");
  expect(contexts.at(-1)).toEqual({
    path: ["key"],
    rootValue: mapOriginal,
    parentValue: mapOriginal,
    currentValue: "old",
  });
  select(map, "Beta Model");
  select(map, "Add key");
  select(map, "Gamma Model");
  expect(contexts.at(-1)).toEqual({
    path: ["gamma/model"],
    rootValue: { "beta/model": "alpha/model" },
    parentValue: { "beta/model": "alpha/model" },
    currentValue: "",
  });
  select(map, "Alpha Model");
  expect(select(map, "Complete entry")).toEqual({
    state: "complete",
    value: { "beta/model": "alpha/model", "gamma/model": "alpha/model" },
  });
  expect(mapOriginal).toEqual({ old: "alpha/model" });
});

test("nested draft contexts include completed sibling changes before enclosing forms finish", () => {
  const contexts: EditorSuggestionContext[] = [];
  const schema: ValueSchema = {
    kind: "structured",
    preserveUnknown: false,
    fields: {
      provider: {
        schema: structure,
        required: true,
        sensitivity: "public",
        description: "Provider.",
      },
    },
  };
  const editor = new TypedEditor(
    schema,
    { provider: { name: "old" } },
    {
      suggestions: (context) => {
        contexts.push(context);
        return catalog(context);
      },
    },
  );
  select(editor, "provider");
  select(editor, "name");
  select(editor, "Beta Model");
  select(editor, "enabled");
  select(editor, "true");
  select(editor, "name");
  expect(contexts.at(-1)).toEqual({
    path: ["provider", "name"],
    rootValue: { provider: { name: "beta/model", enabled: true } },
    parentValue: { name: "beta/model", enabled: true },
    currentValue: "beta/model",
  });
  expect(editor.handleInput(key.enter).state).toBe("editing");
  select(editor, "Complete entry");
  expect(select(editor, "Complete entry")).toEqual({
    state: "complete",
    value: { provider: { name: "beta/model", enabled: true } },
  });
});

test("nonpublic, masked, sensitive-path and key-capture editors never call or show suggestions", () => {
  let calls = 0;
  const suggestions: EditorSuggestions = () => {
    calls++;
    return [{ value: "unsafe", label: "Never shown" }];
  };
  const secret = new TypedEditor({ kind: "text" }, "synthetic-secret", {
    sensitivity: "masked",
    suggestions,
  });
  select(secret, "Replace");
  secret.handleInput("replacement");
  expect(secret.view().input).toBe("[hidden draft]");
  const masked = new TypedEditor(
    { kind: "text" },
    { $piSettingsMasked: true, $token: "opaque-reference" },
    { suggestions },
  );
  expect(JSON.stringify(masked.view())).not.toContain("opaque-reference");
  select(masked, "Replace");
  const fields = new TypedEditor(
    structure,
    { name: "public", token: "synthetic-secret" },
    { suggestions },
  );
  select(fields, "token");
  select(fields, "Replace");
  const headerSchema: ValueSchema = {
    kind: "structured",
    preserveUnknown: false,
    fields: {
      headers: {
        schema: { kind: "map", value: { kind: "text" } },
        sensitivity: "public",
        required: true,
        description: "Headers.",
      },
    },
  };
  const headers = new TypedEditor(
    headerSchema,
    { headers: {} },
    { suggestions },
  );
  select(headers, "headers");
  select(headers, "Add key");
  headers.handleInput("Custom");
  headers.handleInput(key.enter);
  expect(headers.view().input).toBe("[hidden draft]");
  const capture = new TypedEditor(
    {
      kind: "union",
      variants: [{ kind: "text" }, { kind: "list", item: { kind: "text" } }],
    },
    ["ctrl+a"],
    { keyCapture: true, suggestions, initialField: "name" },
  );
  select(capture, "Edit assignment list");
  select(capture, "Add item");
  capture.handleInput("a");
  capture.handleInput(key.enter);
  expect(calls).toBe(0);
  for (const editor of [secret, masked, fields, headers, capture])
    expect(JSON.stringify(editor.view())).not.toContain("Never shown");
  const url = new TypedEditor(
    { kind: "text" },
    "https://user:synthetic-secret@example.test",
    { suggestions, existingValue: false },
  );
  expect(url.view().input).toBe("[hidden draft]");
  expect(calls).toBe(0);
});

test("suggestion labels are sanitized and credential/opaque references cannot become choices", () => {
  const editor = new TypedEditor(
    structure,
    { name: "public", token: "synthetic-original-secret" },
    {
      initialField: "name",
      suggestions: (context) => {
        expect(JSON.stringify(context)).not.toContain(
          "synthetic-original-secret",
        );
        const token = (
          (context.rootValue as Record<string, JsonValue>).token as Record<
            string,
            JsonValue
          >
        ).$token as string;
        return [
          {
            value: "valid",
            label: "Safe\x1b[2J\u202e",
            description: "Readable\ntext",
          },
          { value: "hidden", label: token },
          { value: "hidden2", label: "$token" },
          {
            value: "https://user:synthetic-secret@example.test",
            label: "Secret URL",
          },
        ];
      },
    },
  );
  const view = JSON.stringify(editor.view());
  expect(view).toContain("Safe�[2J�");
  expect(view).toContain("Readable�text");
  expect(view).not.toContain("$token");
  expect(view).not.toContain("Secret URL");
  expect(
    editor.view().lines.filter((line) => line.action === "suggestion"),
  ).toHaveLength(2);
});

test("picker/custom cancellation is draft-local and resolver failures degrade quietly to typed editing", () => {
  const original = { name: "alpha/model" };
  const editor = new TypedEditor(structure, original, {
    initialField: "name",
    suggestions: catalog,
  });
  editor.handleInput("Beta");
  expect(select(editor, "Back without").state).toBe("editing");
  select(editor, "name");
  expect(editor.view().lines.find((line) => line.selected)?.label).toBe(
    "Alpha Model",
  );
  select(editor, "Beta Model");
  select(editor, "name");
  editor.handleInput(key.tab);
  text(editor, "uncommitted");
  expect(editor.handleInput(key.escape)).toEqual({ state: "cancelled" });
  expect(original).toEqual({ name: "alpha/model" });
  const fallback = new TypedEditor({ kind: "text" }, "current", {
    suggestions: () => {
      throw new Error("synthetic-sensitive-diagnostic");
    },
  });
  expect(fallback.view().input).toBe("current");
  expect(fallback.view().help).not.toContain("Tab");
  expect(JSON.stringify(fallback.view())).not.toContain(
    "synthetic-sensitive-diagnostic",
  );
  text(fallback, "custom/*");
  expect(fallback.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "custom/*",
  });
});

test("root and nested union contexts are local draft snapshots, including redacted replacements", () => {
  const contexts: EditorSuggestionContext[] = [];
  const suggestions: EditorSuggestions = (context) => {
    contexts.push(context);
    return catalog(context);
  };
  new TypedEditor({ kind: "text" }, "alpha/model", { suggestions });
  expect(contexts[0]).toEqual({
    path: [],
    rootValue: "alpha/model",
    parentValue: null,
    currentValue: "alpha/model",
  });
  const union: ValueSchema = {
    kind: "union",
    variants: [structure, { kind: "text" }],
  };
  const editor = new TypedEditor(
    union,
    { name: "alpha/model", token: "synthetic-sensitive" },
    { suggestions },
  );
  select(editor, "Variant 1");
  select(editor, "token");
  select(editor, "Replace");
  editor.handleInput("synthetic-replacement");
  editor.handleInput(key.enter);
  select(editor, "name");
  expect(contexts.at(-1)?.path).toEqual(["structured", "name"]);
  expect(contexts.at(-1)?.rootValue).toMatchObject({
    name: "alpha/model",
    token: { $piSettingsMasked: true },
  });
  expect(JSON.stringify(contexts)).not.toContain("synthetic-sensitive");
  expect(JSON.stringify(contexts)).not.toContain("synthetic-replacement");
});

test("custom values that acquire embedded credentials leave picker mode and stay hidden", () => {
  let calls = 0;
  const editor = new TypedEditor({ kind: "text" }, "", {
    suggestions: (context) => {
      calls++;
      return catalog(context);
    },
  });
  editor.handleInput(key.tab);
  editor.handleInput("https://user:synthetic-typed-secret@example.test");
  expect(editor.view().input).toBe("[hidden draft]");
  expect(editor.view().help).not.toContain("Tab");
  editor.handleInput(key.tab);
  expect(editor.view().lines.some((line) => line.action === "suggestion")).toBe(
    false,
  );
  expect(JSON.stringify(editor.view())).not.toContain("synthetic-typed-secret");
  expect(calls).toBe(1);
  expect(editor.handleInput(key.enter)).toEqual({
    state: "complete",
    value: "https://user:synthetic-typed-secret@example.test",
  });
});
