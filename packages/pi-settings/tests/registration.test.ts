import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  registerSettings,
  SETTINGS_CHANNELS,
  type SettingsOperations,
} from "../src/registration.ts";
import { SettingsRegistry, type RegistryChange } from "../src/registry.ts";
import { MetadataSearchIndex } from "../src/search.ts";
import {
  SyntheticBus,
  syntheticExtension,
} from "./fixtures/synthetic-extension.ts";

for (const providerFirst of [true, false]) {
  test(`discovery supports ${providerFirst ? "provider" : "center"}-first load and repeated opens`, () => {
    const bus = new SyntheticBus();
    const early = providerFirst ? syntheticExtension(bus) : undefined;
    const registry = new SettingsRegistry(bus);
    const provider = early ?? syntheticExtension(bus);
    for (let i = 0; i < 4; i++) registry.open();
    expect(registry.list()).toHaveLength(1);
    expect(registry.catalog()).toHaveLength(1);
    expect(registry.list()[0]?.tab).toBe("Extensions");
    expect(registry.catalog()[0]?.sourceLabel).toBe(
      "Extensions / Synthetic tools / Advanced behavior",
    );
    expect(provider.calls).toEqual({
      read: 0,
      validate: 0,
      write: 0,
      remove: 0,
    });
    provider.cleanup();
    registry.dispose();
    expect(bus.count()).toBe(0);
  });
}

test("helper is functional without a consumer, answers only v1, withdraws once", () => {
  const bus = new SyntheticBus();
  const provider = syntheticExtension(bus);
  expect(provider.ordinary()).toBe("ordinary-1");
  expect(
    bus.emitted.filter((event) => event.channel === SETTINGS_CHANNELS.register),
  ).toHaveLength(1);
  bus.emit(SETTINGS_CHANNELS.request, { protocolVersion: 2 });
  bus.emit(SETTINGS_CHANNELS.request, null);
  bus.emit(SETTINGS_CHANNELS.request, { protocolVersion: 1 });
  expect(
    bus.emitted.filter((event) => event.channel === SETTINGS_CHANNELS.register),
  ).toHaveLength(2);
  provider.cleanup();
  provider.cleanup();
  expect(bus.count()).toBe(0);
  expect(
    bus.emitted.filter(
      (event) => event.channel === SETTINGS_CHANNELS.unregister,
    ),
  ).toHaveLength(1);
  expect(provider.ordinary()).toBe("ordinary-2");
  expect(syntheticExtension().ordinary()).toBe("ordinary-1");
});

test("same owner announcements are idempotent, replacements invalidate stale handles", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const changes: RegistryChange[] = [];
  registry.subscribe((change) => changes.push(change));
  const provider = syntheticExtension(bus);
  registry.open();
  registry.open();
  expect(changes.filter((change) => change.type === "registered")).toHaveLength(
    1,
  );
  const stale = registry.operations("synthetic");
  const replacement = { ...provider.payload, displayName: "Updated tools" };
  bus.emit(SETTINGS_CHANNELS.register, replacement);
  expect(registry.list()).toHaveLength(1);
  expect(registry.list()[0]?.displayName).toBe("Updated tools");
  expect(changes.filter((change) => change.type === "withdrawn")).toHaveLength(
    1,
  );
  expect(
    (
      await stale?.read("synthetic.advanced.enabled", "user", {
        signal: new AbortController().signal,
      })
    )?.state,
  ).toBe("unavailable");
  // Consumers cannot mutate the registry's snapshot through catalog copies.
  const copy = registry.catalog();
  if (copy[0]) copy[0].scopes = ["project"];
  expect(registry.catalog()[0]?.scopes).toEqual(["user"]);
  provider.cleanup();
  registry.dispose();
});

test("non-enumerable operation callbacks remain idempotent across repeated discovery", () => {
  const bus = new SyntheticBus();
  const provider = syntheticExtension();
  for (const [name, callback] of Object.entries(provider.payload.operations))
    Object.defineProperty(provider.payload.operations, name, {
      value: callback,
      enumerable: false,
    });
  const cleanup = registerSettings(bus, provider.payload);
  const registry = new SettingsRegistry(bus);
  const changes: RegistryChange[] = [];
  registry.subscribe((change) => changes.push(change));
  registry.open();
  registry.open();
  expect(changes).toEqual([]);
  expect(registry.catalog()).toHaveLength(1);
  cleanup();
  registry.dispose();
});

test("same-owner replacement keeps ownership locked during reentrant withdrawal notifications", () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension(bus);
  const other = syntheticExtension().payload;
  registry.subscribe((change) => {
    if (change.type === "withdrawn")
      bus.emit(SETTINGS_CHANNELS.register, other);
  });
  bus.emit(SETTINGS_CHANNELS.register, {
    ...provider.payload,
    displayName: "Replacement",
  });
  expect(registry.list()[0]?.displayName).toBe("Replacement");
  provider.cleanup();
  registry.dispose();
});

test("ownership conflicts and foreign withdrawals cannot evict the current provider", () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const first = syntheticExtension(bus);
  const second = syntheticExtension(bus);
  expect(registry.list()).toHaveLength(1);
  second.cleanup();
  expect(registry.list()).toHaveLength(1);
  bus.emit(SETTINGS_CHANNELS.unregister, {
    protocolVersion: 2,
    extensionId: "synthetic",
    owner: first.payload.owner,
  });
  expect(registry.list()).toHaveLength(1);
  first.cleanup();
  expect(registry.catalog()).toEqual([]);
  registry.dispose();
});

test("withdrawal notifies editor/search consumers and reload discards listeners and owner records", () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension(bus);
  const search = new MetadataSearchIndex(registry.catalog());
  let incompleteEditor: string | undefined = "synthetic.advanced.enabled";
  const unsubscribe = registry.subscribe((change) => {
    search.replace(registry.catalog());
    if (
      change.type === "withdrawn" &&
      change.descriptorIds.includes(incompleteEditor ?? "")
    )
      incompleteEditor = undefined;
  });
  expect(search.search("advanced")).toHaveLength(1);
  provider.cleanup();
  expect(incompleteEditor).toBeUndefined();
  expect(search.search("advanced")).toEqual([]);
  expect(provider.calls.write).toBe(0);
  unsubscribe();
  registry.dispose();
  registry.dispose();
  registry.open();
  expect(bus.count()).toBe(0);
  const fresh = new SettingsRegistry(bus);
  const reloaded = syntheticExtension(bus);
  fresh.open();
  expect(fresh.catalog()).toHaveLength(1);
  expect(registry.catalog()).toEqual([]);
  reloaded.cleanup();
  fresh.dispose();
  expect(bus.count()).toBe(0);
});

test("raw structural event protocol needs no helper or package dependency", () => {
  const bus = new SyntheticBus();
  const payload = syntheticExtension().payload;
  // A raw consumer can implement these string channels without importing any package.
  const off = bus.on("pi-settings:v1:request", (request) => {
    if ((request as { protocolVersion?: number })?.protocolVersion === 1)
      bus.emit("pi-settings:v1:register", payload);
  });
  bus.emit("pi-settings:v1:register", payload);
  const registry = new SettingsRegistry(bus);
  expect(registry.list()).toHaveLength(1);
  off();
  bus.emit("pi-settings:v1:unregister", {
    protocolVersion: 1,
    extensionId: payload.extensionId,
    owner: payload.owner,
  });
  expect(registry.list()).toEqual([]);
  registry.dispose();
});

test("registration module and fixture do not import the entrypoint or host runtime", async () => {
  const source = await readFile(
    new URL("../src/registration.ts", import.meta.url),
    "utf8",
  );
  const fixture = await readFile(
    new URL("./fixtures/synthetic-extension.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toMatch(/from\s+["'](?:.*index|@earendil|node:)/);
  expect(source).not.toMatch(
    /SettingsRegistry|SettingsManager|readFile|writeFile/,
  );
  expect(fixture).toContain('from "../../src/registration.ts"');
  expect(fixture).not.toMatch(/from\s+["'](?:.*index|@earendil|.*contracts)/);
  expect(typeof registerSettings).toBe("function");
});

test("shared methods with a new operations receiver replace the owner generation; the same receiver remains idempotent", async () => {
  const bus = new SyntheticBus();
  const registry = new SettingsRegistry(bus);
  const provider = syntheticExtension();
  const changes: RegistryChange[] = [];
  registry.subscribe((change) => changes.push(change));
  const methods = {
    async read(
      this: { value: boolean },
      _id: string,
      scope: "user" | "project",
    ) {
      return {
        ...provider.read(scope),
        configured: { present: true as const, value: this.value },
      };
    },
    async validate() {
      return { valid: true };
    },
    async write() {
      return { state: "failed" as const, message: "safe" };
    },
  };
  const first = { ...methods, value: false };
  bus.emit(SETTINGS_CHANNELS.register, {
    ...provider.payload,
    operations: first,
  });
  const stale = registry.operations("synthetic") as SettingsOperations;
  bus.emit(SETTINGS_CHANNELS.register, {
    ...provider.payload,
    operations: first,
  });
  expect(changes.filter((change) => change.type === "registered")).toHaveLength(
    1,
  );
  const second = { ...methods, value: true };
  bus.emit(SETTINGS_CHANNELS.register, {
    ...provider.payload,
    operations: second,
  });
  bus.emit(SETTINGS_CHANNELS.register, {
    ...provider.payload,
    operations: second,
  });
  expect(changes.filter((change) => change.type === "registered")).toHaveLength(
    2,
  );
  expect(changes.filter((change) => change.type === "withdrawn")).toHaveLength(
    1,
  );
  const context = { signal: new AbortController().signal };
  expect(
    (await stale.read("synthetic.advanced.enabled", "user", context)).state,
  ).toBe("unavailable");
  const read = await registry
    .operations("synthetic")
    ?.read("synthetic.advanced.enabled", "user", context);
  expect(read).toMatchObject({
    state: "available",
    configured: { present: true, value: true },
  });
  registry.dispose();
});

test("safe diagnostics reach the host during constructor discovery and isolate observer exceptions", () => {
  const bus = new SyntheticBus();
  const warnings: string[] = [];
  const off = bus.on(SETTINGS_CHANNELS.request, () => {
    bus.emit(SETTINGS_CHANNELS.register, {
      protocolVersion: 999,
      secret: "never-render-secret",
    });
    bus.emit(SETTINGS_CHANNELS.register, syntheticExtension().payload);
  });
  const registry = new SettingsRegistry(bus, {
    onDiagnostic(message) {
      warnings.push(message);
      throw new Error("host-render-failed");
    },
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Invalid or unsupported");
  expect(warnings.join()).not.toContain("never-render-secret");
  expect(registry.list()).toHaveLength(1);
  const changes: RegistryChange[] = [];
  registry.subscribe((change) => changes.push(change));
  bus.emit(SETTINGS_CHANNELS.register, { protocolVersion: 999 });
  expect(warnings).toHaveLength(2);
  expect(changes).toMatchObject([{ type: "diagnostic" }]);
  off();
  registry.dispose();
});
