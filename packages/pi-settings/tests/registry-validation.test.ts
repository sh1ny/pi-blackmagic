import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CenterCatalog } from "../src/center-catalog.ts";
import type {
  EditResult,
  EditTransaction,
  JsonValue,
  ScopedReadResult,
  SettingDescriptor,
  SettingsOperations,
  ValueSchema,
} from "../src/registration.ts";
import { SETTINGS_CHANNELS } from "../src/registration.ts";
import { SettingsRegistry, type RegistryChange } from "../src/registry.ts";
import { MetadataSearchIndex } from "../src/search.ts";
import { MASKED_VALUE, maskValue } from "../src/redaction.ts";
import { SettingsCenterController } from "../src/ui-controller.ts";
import {
  persisted,
  SyntheticBus,
  syntheticExtension,
  transaction,
} from "./fixtures/synthetic-extension.ts";

const context = () => ({ signal: new AbortController().signal });
const invalid: {
  name: string;
  mutate: (payload: Record<string, unknown>) => void;
}[] = [
  {
    name: "version",
    mutate: (p) => {
      p.protocolVersion = 2;
    },
  },
  {
    name: "missing version",
    mutate: (p) => {
      delete p.protocolVersion;
    },
  },
  {
    name: "extension ID",
    mutate: (p) => {
      p.extensionId = "../ secret\n";
    },
  },
  {
    name: "empty extension ID",
    mutate: (p) => {
      p.extensionId = "";
    },
  },
  {
    name: "owner",
    mutate: (p) => {
      p.owner = "shared-string";
    },
  },
  {
    name: "display escape",
    mutate: (p) => {
      p.displayName = "\u001b[31msecret";
    },
  },
  {
    name: "duplicate page",
    mutate: (p) => {
      const pages = p.pages as unknown[];
      pages.push(pages[0]);
    },
  },
  {
    name: "missing operations",
    mutate: (p) => {
      p.operations = {};
    },
  },
  {
    name: "remove callback",
    mutate: (p) => {
      p.operations = { ...(p.operations as object), removeOverride: true };
    },
  },
];
for (const { name, mutate } of invalid) {
  test(`rejects malformed registration: ${name}`, () => {
    const bus = new SyntheticBus();
    const registry = new SettingsRegistry(bus);
    const payload = syntheticExtension().payload;
    mutate(payload as unknown as Record<string, unknown>);
    bus.emit(SETTINGS_CHANNELS.register, payload);
    expect(registry.list()).toEqual([]);
    registry.dispose();
  });
}

const badDescriptors: Partial<SettingDescriptor>[] = [
  { id: "" },
  { id: "bad\nsecret" },
  { providerId: "other" },
  { pageId: "absent" },
  { path: [] },
  { path: ["__proto__"] },
  { scopes: [] },
  { scopes: ["user", "user"] },
  { scopes: ["global" as "user"] },
  { sensitivity: "secret" as "public" },
  { metadataSensitivity: "secret" as "public" },
  { activation: "unknown" as "reload" },
  { schema: { kind: "unknown" } as unknown as ValueSchema },
  {
    schema: { kind: "list", item: { kind: "text" }, minItems: 3, maxItems: 2 },
  },
  { schema: { kind: "text", minLength: -1 } },
  { schema: { kind: "text", minLength: 4, maxLength: 2 } },
  { schema: { kind: "number", minimum: 4, maximum: 3 } },
  { schema: { kind: "number", exclusiveMinimum: 4, maximum: 4 } },
  { schema: { kind: "number", minimum: Number.NaN } },
  { schema: { kind: "choice", values: [] } },
  { schema: { kind: "choice", values: [1, 1] } },
  { schema: { kind: "union", variants: [] } },
  {
    schema: {
      kind: "map",
      value: { kind: "unknown" } as unknown as ValueSchema,
    },
  },
  {
    schema: {
      kind: "structured",
      preserveUnknown: true,
      fields: {
        entry: {
          required: true,
          sensitivity: "bad" as "public",
          description: "",
          schema: { kind: "json" },
        },
      },
    },
  },
];
for (const [index, descriptor] of badDescriptors.entries()) {
  test(`rejects malformed recursive descriptor ${index}`, () => {
    const bus = new SyntheticBus();
    const registry = new SettingsRegistry(bus);
    const payload = syntheticExtension().payload;
    const original = payload.descriptors[0] as SettingDescriptor;
    bus.emit(SETTINGS_CHANNELS.register, {
      ...payload,
      descriptors: [{ ...original, ...descriptor }],
    });
    expect(registry.catalog()).toEqual([]);
    registry.dispose();
  });
}

test("rejects cycles, getters, duplicate identities and cross-provider identity collisions safely", () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension();
  const descriptor = provider.payload.descriptors[0] as SettingDescriptor;
  const cycle: Record<string, unknown> = { kind: "list" };
  cycle.item = cycle;
  bus.emit(SETTINGS_CHANNELS.register, {
    ...provider.payload,
    descriptors: [{ ...descriptor, schema: cycle }],
  });
  bus.emit(SETTINGS_CHANNELS.register, {
    ...provider.payload,
    descriptors: [descriptor, descriptor],
  });
  const getter = {
    get protocolVersion() {
      throw new Error("synthetic-secret");
    },
  };
  bus.emit(SETTINGS_CHANNELS.register, getter);
  bus.emit(SETTINGS_CHANNELS.unregister, getter);
  expect(registry.list()).toEqual([]);
  bus.emit(SETTINGS_CHANNELS.register, provider.payload);
  const other = syntheticExtension(undefined, "other");
  bus.emit(SETTINGS_CHANNELS.register, {
    ...other.payload,
    descriptors: [{ ...other.payload.descriptors[0], id: descriptor.id }],
  });
  expect(registry.list()).toHaveLength(1);
  registry.dispose();
});

test("all supported recursive schema kinds register and local value constraints prevent plugin dispatch", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension();
  const schemas: ValueSchema[] = [
    { kind: "json" },
    { kind: "boolean" },
    { kind: "choice", values: [null, true, "auto", 1] },
    { kind: "text", minLength: 1, maxLength: 5 },
    { kind: "number", exclusiveMinimum: 0, maximum: 3, integer: true },
    { kind: "union", variants: [{ kind: "text" }, { kind: "number" }] },
    { kind: "list", minItems: 1, maxItems: 2, item: { kind: "boolean" } },
    { kind: "map", value: { kind: "text" } },
    {
      kind: "structured",
      preserveUnknown: true,
      fields: {
        token: {
          required: false,
          sensitivity: "masked",
          description: "Synthetic token",
          schema: { kind: "text" },
        },
      },
    },
  ];
  const descriptor = provider.payload.descriptors[0] as SettingDescriptor;
  const descriptors = schemas.map((schema, i) => ({
    ...descriptor,
    id: `synthetic.advanced.${i}`,
    schema,
  }));
  bus.emit(SETTINGS_CHANNELS.register, { ...provider.payload, descriptors });
  expect(registry.catalog()).toHaveLength(schemas.length);
  const ops = registry.operations("synthetic") as SettingsOperations;
  for (const [i, value] of [
    [4, 0],
    [4, 1.5],
    [6, []],
    [6, [true, false, true]],
    [3, "too-long"],
  ] as const) {
    const result = await ops.write(
      {
        ...transaction(),
        descriptorId: `synthetic.advanced.${i}`,
        value: value as unknown as number,
      },
      context(),
    );
    expect(result.state).toBe("rejected");
  }
  expect(provider.calls.write).toBe(0);
  expect(provider.calls.validate).toBe(0);
  registry.dispose();
});

test("declared scopes and operations are enforced; plugin owns acknowledgement and activation", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension(bus);
  const ops = registry.operations("synthetic") as SettingsOperations;
  expect(
    (await ops.read("synthetic.advanced.enabled", "project", context())).state,
  ).toBe("unavailable");
  expect(
    (await ops.write({ ...transaction(), scope: "project" }, context())).state,
  ).toBe("rejected");
  expect(provider.calls.read).toBe(0);
  expect(provider.calls.validate).toBe(0);
  const result = await ops.write(transaction(), context());
  expect(result).toEqual(persisted());
  expect(provider.calls).toEqual({ read: 0, validate: 1, write: 1, remove: 0 });
  const removed = await ops.removeOverride?.(
    { ...transaction(), operation: "remove-override" },
    context(),
  );
  expect(removed?.state).toBe("persisted");
  expect(provider.calls.remove).toBe(1);
  provider.cleanup();
  registry.dispose();
});

test("uncloneable edit does not strand the provider lane", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension(bus);
  const ops = registry.operations("synthetic") as SettingsOperations;
  const malformed = {
    ...transaction(),
    operation: "remove-override" as const,
    extra: () => {},
  };
  expect((await ops.write(malformed, context())).state).toBe("failed");
  expect((await ops.write(transaction(), context())).state).toBe("persisted");
  provider.cleanup();
  registry.dispose();
});

test("rejects sparse protocol and schema arrays rather than skipping missing entries", () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension();
  const descriptor = provider.payload.descriptors[0] as SettingDescriptor;
  for (const payload of [
    { ...provider.payload, pages: Array(1) },
    { ...provider.payload, descriptors: Array(1) },
    { ...provider.payload, descriptors: [{ ...descriptor, scopes: Array(1) }] },
    { ...provider.payload, descriptors: [{ ...descriptor, path: Array(1) }] },
    {
      ...provider.payload,
      descriptors: [
        { ...descriptor, schema: { kind: "choice", values: Array(1) } },
      ],
    },
    {
      ...provider.payload,
      descriptors: [
        { ...descriptor, schema: { kind: "union", variants: Array(1) } },
      ],
    },
  ]) {
    bus.emit(SETTINGS_CHANNELS.register, payload);
    expect(registry.list()).toEqual([]);
  }
  registry.dispose();
});

test("missing removal callback never falls back to write", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension();
  delete provider.payload.operations.removeOverride;
  bus.emit(SETTINGS_CHANNELS.register, provider.payload);
  const result = await registry
    .operations("synthetic")
    ?.removeOverride?.(
      { ...transaction(), operation: "remove-override" },
      context(),
    );
  expect(result?.state).toBe("rejected");
  expect(provider.calls.write).toBe(0);
  registry.dispose();
});

test("provider validation rejects before persistence and failing providers never disable other catalogs", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const broken = syntheticExtension();
  const good = syntheticExtension(bus, "good");
  broken.payload.operations.read = async () => {
    throw new Error("synthetic-secret");
  };
  broken.payload.operations.validate = async () => ({
    valid: false,
    message: "synthetic-secret",
  });
  bus.emit(SETTINGS_CHANNELS.register, broken.payload);
  expect(
    (
      await registry
        .operations("synthetic")
        ?.read("synthetic.advanced.enabled", "user", context())
    )?.state,
  ).toBe("error");
  expect(
    (await registry.operations("synthetic")?.write(transaction(), context()))
      ?.state,
  ).toBe("rejected");
  expect(broken.calls.write).toBe(0);
  expect(
    (await registry.operations("good")?.write(transaction("good"), context()))
      ?.state,
  ).toBe("persisted");
  expect(registry.list()).toHaveLength(2);
  good.cleanup();
  registry.dispose();
});

test("raw exceptions and every returned diagnostic are withheld including activation failures", async () => {
  const secret = "synthetic-token-never-render";
  const results: EditResult[] = [
    { state: "failed", message: secret },
    { state: "rejected", reason: "conflict", message: secret },
    { state: "indeterminate", requiresReadBack: true, message: secret },
    {
      ...persisted(),
      activation: { state: "failed", requirement: "reload", message: secret },
    } as EditResult,
  ];
  for (const value of results) {
    const bus = new SyntheticBus();
    const registry = new SettingsRegistry(bus);
    const provider = syntheticExtension();
    const changes: RegistryChange[] = [];
    registry.subscribe((change) => changes.push(change));
    provider.payload.operations.write = async () => value;
    bus.emit(SETTINGS_CHANNELS.register, provider.payload);
    const returned = await registry
      .operations("synthetic")
      ?.write(transaction(), context());
    expect(JSON.stringify(returned)).not.toContain(secret);
    expect(JSON.stringify(changes)).not.toContain(secret);
    registry.dispose();
  }
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension();
  provider.payload.operations.read = async () => ({
    state: "unavailable",
    scope: "user",
    reason: secret,
  });
  provider.payload.operations.validate = async () => {
    throw new Error(secret);
  };
  bus.emit(SETTINGS_CHANNELS.register, provider.payload);
  expect(
    JSON.stringify(
      await registry
        .operations("synthetic")
        ?.read("synthetic.advanced.enabled", "user", context()),
    ),
  ).not.toContain(secret);
  expect(
    JSON.stringify(
      await registry
        .operations("synthetic")
        ?.validate(transaction(), context()),
    ),
  ).not.toContain(secret);
  registry.dispose();
});

test("sensitivity is independent of metadata search, nested values are masked without entering notifications", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension();
  const descriptor = provider.payload.descriptors[0] as SettingDescriptor;
  descriptor.schema = {
    kind: "structured",
    preserveUnknown: true,
    fields: {
      token: {
        schema: { kind: "text" },
        sensitivity: "masked",
        required: true,
        description: "Token",
      },
    },
  };
  provider.payload.operations.read = async () => ({
    ...provider.read("user"),
    state: "available",
    scope: "user",
    configured: {
      present: true,
      value: { token: "synthetic-secret", future: "hidden" },
    },
    effective: { known: false },
    revision: "0",
    provenance: { source: "user", sessionState: "unknown" },
  });
  bus.emit(SETTINGS_CHANNELS.register, provider.payload);
  const read = await registry
    .operations("synthetic")
    ?.read(descriptor.id, "user", context());
  expect(
    read && JSON.stringify(registry.maskRead("synthetic", descriptor.id, read)),
  ).not.toContain("synthetic-secret");
  expect(
    new MetadataSearchIndex(registry.catalog()).search("synthetic-secret"),
  ).toEqual([]);
  expect(
    new MetadataSearchIndex(registry.catalog()).search("enabled"),
  ).toHaveLength(1);
  descriptor.metadataSensitivity = "masked";
  bus.emit(SETTINGS_CHANNELS.register, provider.payload);
  expect(new MetadataSearchIndex(registry.catalog()).search("enabled")).toEqual(
    [],
  );
  registry.dispose();
});

test("invalid callback outputs are safe, scoped reads must acknowledge the requested scope", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension();
  provider.payload.operations.read = async () => provider.read("project");
  provider.payload.operations.write = async () => ({
    state: "persisted",
    read: provider.read("project"),
    activation: { state: "active" },
  });
  bus.emit(SETTINGS_CHANNELS.register, provider.payload);
  const ops = registry.operations("synthetic") as SettingsOperations;
  expect(
    (await ops.read("synthetic.advanced.enabled", "user", context())).state,
  ).toBe("error");
  expect((await ops.write(transaction(), context())).state).toBe("failed");
  registry.dispose();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function settleController(controller: SettingsCenterController) {
  for (let i = 0; i < 100 && controller.view().pending; i++)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(controller.view().pending).toBe(false);
}
function editorAction(controller: SettingsCenterController, prefix: string) {
  const index =
    controller
      .view()
      .editor?.lines.findIndex((line) => line.label.startsWith(prefix)) ?? -1;
  expect(index).toBeGreaterThanOrEqual(0);
  while ((controller.view().editor?.selected ?? 0) < index)
    controller.handleInput("\x1b[B");
  while ((controller.view().editor?.selected ?? 0) > index)
    controller.handleInput("\x1b[A");
  controller.handleInput("\r");
}
function credentialProvider(
  value: JsonValue,
  schema: ValueSchema,
  masked = false,
) {
  const provider = syntheticExtension();
  const descriptor = provider.payload.descriptors[0] as SettingDescriptor;
  descriptor.schema = schema;
  descriptor.sensitivity = masked ? "masked" : "public";
  descriptor.scopes = ["user", "project"];
  let current = value;
  let revision = "0";
  const validated: EditTransaction[] = [];
  const written: EditTransaction[] = [];
  const read = (
    scope: "user" | "project",
  ): Extract<ScopedReadResult, { state: "available" }> => ({
    ...provider.read(scope),
    configured: { present: true, value: current },
    effective: { known: true, value: current },
    revision,
  });
  provider.payload.operations.read = async (_id, scope) => read(scope);
  provider.payload.operations.validate = async (transaction) => {
    validated.push(structuredClone(transaction));
    // A trusted callback still must not mutate the eventual write or the UI draft.
    if (transaction.operation !== "remove-override")
      transaction.value = "provider-mutated-validation";
    return { valid: true };
  };
  provider.payload.operations.write = async (transaction) => {
    written.push(structuredClone(transaction));
    if (transaction.operation !== "remove-override")
      current = structuredClone(transaction.value);
    revision = String(Number(revision) + 1);
    return {
      state: "persisted",
      read: read(transaction.scope),
      activation: { state: "active" },
    };
  };
  return { provider, descriptor, validated, written, read };
}

for (const kind of ["text", "json"] as const) {
  test(`actual catalog/controller ${kind} editor retains credentials as raw provider values and supports deliberate replacement`, async () => {
    const bus = new SyntheticBus();
    const registry = new SettingsRegistry(bus);
    const raw =
      kind === "text"
        ? "!credential-expression-never-evaluated"
        : { apiKey: "synthetic-api-secret", enabled: true };
    const fixture = credentialProvider(raw, { kind }, kind === "text");
    bus.emit(SETTINGS_CHANNELS.register, fixture.provider.payload);
    const directory = join(tmpdir(), `pi-settings-registry-${randomUUID()}`);
    const catalog = new CenterCatalog({
      context: { cwd: directory, isProjectTrusted: () => true },
      agentDirectory: () => directory,
      keybindings: { getEffectiveConfig: () => ({}) },
      registry,
      onChange: () => {},
    });
    const rows = catalog
      .rows()
      .filter((row) => row.descriptor.id === fixture.descriptor.id);
    const controller = new SettingsCenterController(rows, {
      tabs: ["Extensions"],
      onChange: () => {},
      onClose: () => {},
    });
    try {
      await tick();
      controller.handleInput("\r");
      await tick();
      expect(JSON.stringify(controller.view())).not.toContain(
        kind === "text" ? (raw as string) : "synthetic-api-secret",
      );
      if (kind === "text") editorAction(controller, "Retain");
      else {
        // Credential-bearing JSON is hidden even while opaque references are retained.
        expect(controller.view().editor?.input).toBe("[hidden draft]");
        controller.handleInput("\r");
      }
      await settleController(controller);
      expect(controller.view().status.kind).toBe("saved");
      expect(fixture.validated[0]).toMatchObject({ value: raw });
      expect(fixture.written[0]).toMatchObject({ value: raw });
      expect(JSON.stringify(fixture.written[0])).not.toContain(
        "$piSettingsMasked",
      );
      controller.handleInput("\r"); // acknowledge saved
      controller.handleInput("\r"); // edit fresh revision
      await tick();
      if (kind === "text") editorAction(controller, "Replace");
      else {
        controller.handleInput("\x1b[F");
        for (let i = 0; i < 500; i++) controller.handleInput("\x7f");
      }
      const replacement: JsonValue =
        kind === "text"
          ? ""
          : { apiKey: "deliberate-new-secret", enabled: false };
      controller.handleInput(
        kind === "text" ? "" : JSON.stringify(replacement),
      );
      controller.handleInput("\r");
      await settleController(controller);
      expect(fixture.written[1]).toMatchObject({ value: replacement });
    } finally {
      controller.dispose();
      catalog.dispose();
      registry.dispose();
    }
  });
}

test("direct validation and edit restore opaque tokens against a private descriptor/scope/revision baseline without mutating input", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const fixture = credentialProvider(
    { apiKey: "synthetic-original", list: ["visible"] },
    { kind: "json" },
  );
  bus.emit(SETTINGS_CHANNELS.register, fixture.provider.payload);
  const ops = registry.operations("synthetic") as SettingsOperations;
  const read = await ops.read(fixture.descriptor.id, "user", context());
  if (read.state !== "available" || !read.configured.present)
    throw new Error("Missing baseline");
  const draft = maskValue(read.configured.value, fixture.descriptor);
  // Changing the public result cannot corrupt the registry's private baseline.
  read.configured.value = "tampered";
  const input = { ...transaction(), value: draft };
  expect(await ops.validate(input, context())).toEqual({ valid: true });
  expect((await ops.write(input, context())).state).toBe("persisted");
  expect(fixture.validated).toHaveLength(2);
  expect(fixture.written[0]).toMatchObject({
    value: { apiKey: "synthetic-original", list: ["visible"] },
  });
  expect(input.value).toEqual(draft);
  expect(JSON.stringify(input)).toContain("$token");
  registry.dispose();
});

test("masked drafts reject missing, wrong scope/revision, expired or new references before provider dispatch", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const fixture = credentialProvider(
    { apiKey: "synthetic-original" },
    { kind: "json" },
  );
  bus.emit(SETTINGS_CHANNELS.register, fixture.provider.payload);
  const ops = registry.operations("synthetic") as SettingsOperations;
  const masked = maskValue(
    { apiKey: "synthetic-original" },
    fixture.descriptor,
  );
  const input = { ...transaction(), value: masked };
  expect((await ops.validate(input, context())).valid).toBe(false);
  expect((await ops.write(input, context())).state).toBe("rejected");
  await ops.read(fixture.descriptor.id, "user", context());
  for (const invalid of [
    { ...input, scope: "project" as const },
    { ...input, expectedRevision: "other" },
    { ...input, value: { newField: { ...MASKED_VALUE } } },
    {
      ...input,
      value: { apiKey: { ...MASKED_VALUE, $token: "unrecognized-token" } },
    },
  ]) {
    expect((await ops.validate(invalid, context())).valid).toBe(false);
    expect((await ops.write(invalid, context())).state).toBe("rejected");
  }
  expect(fixture.validated).toEqual([]);
  expect(fixture.written).toEqual([]);
  bus.emit(SETTINGS_CHANNELS.register, {
    ...fixture.provider.payload,
    displayName: "Replacement",
  });
  expect(
    (await registry.operations("synthetic")?.validate(input, context()))?.valid,
  ).toBe(false);
  bus.emit(SETTINGS_CHANNELS.unregister, {
    protocolVersion: 1,
    extensionId: "synthetic",
    owner: fixture.provider.payload.owner,
  });
  bus.emit(SETTINGS_CHANNELS.register, fixture.provider.payload);
  expect(
    (await registry.operations("synthetic")?.validate(input, context()))?.valid,
  ).toBe(false);
  registry.dispose();
});

test("schema validation checks restored secret values rather than accepting marker shape", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const fixture = credentialProvider("x", { kind: "text", minLength: 3 }, true);
  bus.emit(SETTINGS_CHANNELS.register, fixture.provider.payload);
  const ops = registry.operations("synthetic") as SettingsOperations;
  await ops.read(fixture.descriptor.id, "user", context());
  const input = { ...transaction(), value: maskValue("x", fixture.descriptor) };
  expect((await ops.validate(input, context())).valid).toBe(false);
  expect((await ops.write(input, context())).state).toBe("rejected");
  expect(fixture.validated).toEqual([]);
  expect(fixture.written).toEqual([]);
  registry.dispose();
});
