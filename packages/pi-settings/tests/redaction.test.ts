import { expect, test } from "bun:test";
import type { JsonValue, SettingDescriptor } from "../src/contracts.ts";
import {
  maskValue,
  restoreMasked,
  clearMaskedReferences,
  safeDiagnostic,
  safeDisplay,
} from "../src/redaction.ts";
import { MetadataSearchIndex } from "../src/search.ts";

const descriptor: SettingDescriptor = {
  id: "synthetic.server",
  providerId: "synthetic",
  pageId: "MCP",
  path: ["server"],
  label: "Server",
  description: "Synthetic server definition",
  sourceLabel: "MCP",
  sensitivity: "public",
  scopes: ["user"],
  activation: "reload",
  schema: {
    kind: "structured",
    preserveUnknown: true,
    fields: {
      command: {
        schema: { kind: "text" },
        description: "Command",
        required: true,
        sensitivity: "public",
      },
      env: {
        schema: { kind: "map", value: { kind: "text" } },
        description: "Environment",
        required: false,
        sensitivity: "public",
      },
      headers: {
        schema: { kind: "map", value: { kind: "text" } },
        description: "Headers",
        required: false,
        sensitivity: "public",
      },
      apiKey: {
        schema: { kind: "text" },
        description: "Credential",
        required: false,
        sensitivity: "masked",
      },
    },
  },
};
const original: Record<string, JsonValue> = {
  command: "synthetic",
  env: { TOKEN: "synthetic-env-secret" },
  headers: { Authorization: "synthetic-header-secret" },
  apiKey: "!synthetic-command-never-run",
  futureCredential: "synthetic-future-secret",
};

test("masked editor trees preserve untouched credentials while another field changes", () => {
  const draft = maskValue(original, descriptor) as Record<string, JsonValue>;
  draft.command = "edited";
  expect(restoreMasked(draft, original)).toEqual({
    ...original,
    command: "edited",
  });
  const serialized = JSON.stringify(draft);
  for (const secret of [
    "synthetic-env-secret",
    "synthetic-header-secret",
    "!synthetic-command-never-run",
    "synthetic-future-secret",
  ])
    expect(serialized).not.toContain(secret);
});

test("deliberate empty replacement differs from unchanged masked input", () => {
  const draft = maskValue(original, descriptor) as Record<string, JsonValue>;
  draft.apiKey = "";
  const result = restoreMasked(draft, original) as Record<string, JsonValue>;
  expect(result.apiKey).toBe("");
  expect(result.env).toEqual(original.env);
});

test("ordinary display, metadata search, and errors never carry credential values", () => {
  const display = safeDisplay(original, descriptor);
  for (const secret of [
    "synthetic-env-secret",
    "synthetic-header-secret",
    "synthetic-command-never-run",
    "synthetic-future-secret",
  ]) {
    expect(display).not.toContain(secret);
    expect(new MetadataSearchIndex([descriptor]).search(secret)).toEqual([]);
    for (const operation of [
      "read",
      "validation",
      "write",
      "activation",
    ] as const)
      expect(safeDiagnostic(new Error(secret), operation)).not.toContain(
        secret,
      );
  }
  expect(
    safeDisplay("synthetic-proxy-password", {
      sensitivity: "masked",
      schema: { kind: "text" },
    }),
  ).not.toContain("synthetic-proxy-password");
});

test("opaque retention survives map renames and array reordering without misassigning secrets", () => {
  const value: JsonValue = {
    models: [
      { id: "first", apiKey: "synthetic-first-secret" },
      { id: "second", apiKey: "synthetic-second-secret" },
    ],
    headers: { old: "synthetic-header-secret" },
  };
  const schema = {
    sensitivity: "public" as const,
    schema: { kind: "json" as const },
  };
  const draft = maskValue(value, schema) as Record<string, JsonValue>;
  const models = draft.models as JsonValue[];
  draft.models = [models[1] as JsonValue, models[0] as JsonValue];
  const headers = draft.headers as Record<string, JsonValue>;
  draft.headers = { renamed: headers.old as JsonValue };
  expect(restoreMasked(draft, value)).toEqual({
    models: [
      { id: "second", apiKey: "synthetic-second-secret" },
      { id: "first", apiKey: "synthetic-first-secret" },
    ],
    headers: { renamed: "synthetic-header-secret" },
  });
  expect(
    restoreMasked(models[1] as JsonValue, {
      id: "second",
      apiKey: "synthetic-second-secret",
    }),
  ).toEqual({ id: "second", apiKey: "synthetic-second-secret" });
  expect(safeDisplay(draft, schema)).not.toContain("$token");
});

test("stale references and mismatched originals fail safely, and embedded URL credentials stay masked", () => {
  const schema = {
    sensitivity: "public" as const,
    schema: { kind: "text" as const },
  };
  const value =
    "https://synthetic-user:synthetic-password@example.invalid/path";
  const draft = maskValue(value, schema);
  expect(safeDisplay(value, schema)).not.toContain("synthetic-password");
  expect(() => restoreMasked(draft, "unrelated")).toThrow("no original");
  clearMaskedReferences();
  expect(() => restoreMasked(draft, value)).toThrow("refresh");
});

test("union branches mask unknown structured members and preserve known public fields", () => {
  const union: Pick<SettingDescriptor, "schema" | "sensitivity"> = {
    sensitivity: "public",
    schema: {
      kind: "union",
      variants: [{ kind: "boolean" }, descriptor.schema],
    },
  };
  const value = {
    command: "synthetic",
    futureField: "synthetic-unadvertised-secret",
  };
  const draft = maskValue(value, union);
  expect(safeDisplay(value, union)).not.toContain(
    "synthetic-unadvertised-secret",
  );
  expect(safeDisplay(value, union)).toContain("synthetic");
  expect(restoreMasked(draft, value)).toEqual(value);
});

test("retention without an original is rejected rather than persisted as a marker", () => {
  expect(() =>
    restoreMasked({ newCredential: { $piSettingsMasked: true } }, {}),
  ).toThrow("no original");
  expect(() => restoreMasked([{ $piSettingsMasked: true }], [])).toThrow(
    "no original",
  );
});
