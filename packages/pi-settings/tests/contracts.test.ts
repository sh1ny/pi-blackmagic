import { expect, test } from "bun:test";
import type {
  ActivationResult,
  EditResult,
  EditTransaction,
  JsonValue,
  ScopedReadResult,
  SensitiveEdit,
  SettingDescriptor,
  ValueSchema,
} from "../src/contracts.ts";
import { validateValue } from "../src/validation.ts";

const cases: { schema: ValueSchema; valid: JsonValue; invalid: JsonValue }[] = [
  { schema: { kind: "boolean" }, valid: false, invalid: "false" },
  { schema: { kind: "text", minLength: 1 }, valid: "theme", invalid: "" },
  {
    schema: { kind: "number", minimum: 0, maximum: 10, integer: true },
    valid: 4,
    invalid: 1.5,
  },
  {
    schema: { kind: "choice", values: ["auto", "on", "off"] },
    valid: "auto",
    invalid: "unknown",
  },
  {
    schema: {
      kind: "union",
      variants: [
        { kind: "choice", values: ["auto"] },
        { kind: "number", minimum: 0 },
      ],
    },
    valid: "auto",
    invalid: -1,
  },
  {
    schema: { kind: "list", item: { kind: "text" } },
    valid: ["one", "two"],
    invalid: ["one", 2],
  },
  {
    schema: { kind: "map", value: { kind: "number" } },
    valid: { model: 100 },
    invalid: { model: "100" },
  },
  {
    schema: {
      kind: "structured",
      preserveUnknown: true,
      fields: {
        command: {
          schema: { kind: "text", minLength: 1 },
          required: true,
          sensitivity: "public",
          description: "Executable",
        },
        env: {
          schema: { kind: "map", value: { kind: "text" } },
          required: false,
          sensitivity: "masked",
          description: "Environment",
        },
      },
    },
    valid: { command: "synthetic", future: true },
    invalid: { env: {} },
  },
];

for (const { schema, valid, invalid } of cases) {
  test(`${schema.kind} descriptors carry metadata and validate locally`, () => {
    const descriptor: SettingDescriptor = {
      id: `native.general.${schema.kind}`,
      providerId: "native",
      pageId: "general",
      path: [schema.kind],
      label: schema.kind,
      description: "Synthetic descriptor",
      sourceLabel: "General",
      schema,
      scopes: ["user", "project"],
      sensitivity: "public",
      activation: "reload",
    };
    expect(validateValue(descriptor.schema, valid)).toEqual({ valid: true });
    expect(validateValue(descriptor.schema, invalid).valid).toBe(false);
  });
}

test("scoped results distinguish absence, unknown effective state, and trust denial", () => {
  const read: ScopedReadResult = {
    state: "available",
    scope: "user",
    configured: { present: false },
    effective: { known: false },
    revision: "revision-1",
    provenance: { source: "default", sessionState: "unknown" },
  };
  const blocked: ScopedReadResult = {
    state: "unavailable",
    scope: "project",
    reason: "Project is not trusted.",
  };
  expect(read.configured.present).toBe(false);
  expect(blocked.state).toBe("unavailable");
  const transaction: EditTransaction = {
    descriptorId: "native.general.theme",
    scope: "user",
    expectedRevision: read.revision,
    operation: "set",
    value: "dark",
  };
  expect(transaction.expectedRevision).toBe("revision-1");
  const activation: ActivationResult = {
    state: "failed",
    requirement: "immediate",
    message: "Saved but not active.",
  };
  const saved: EditResult = { state: "persisted", read, activation };
  expect(saved.state).toBe("persisted");
  expect(saved.activation.state).toBe("failed");
});

test("masked retention is distinct from deliberate empty replacement", () => {
  const retain: SensitiveEdit = { operation: "retain" };
  const empty: SensitiveEdit = { operation: "replace", value: "" };
  expect(retain).not.toEqual(empty);
});

test("validation diagnostics do not contain submitted secrets", () => {
  const result = validateValue(
    { kind: "number" },
    "synthetic-secret-do-not-display",
  );
  expect(JSON.stringify(result)).not.toContain(
    "synthetic-secret-do-not-display",
  );
  expect(validateValue({ kind: "number" }, Number.NaN).valid).toBe(false);
  expect(
    validateValue(
      { kind: "structured", fields: {}, preserveUnknown: false },
      { unknown: true },
    ).valid,
  ).toBe(false);
});
