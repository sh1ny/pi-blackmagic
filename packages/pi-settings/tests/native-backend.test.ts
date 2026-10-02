import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  EditTransaction,
  JsonValue,
  ValueSchema,
} from "../src/contracts.ts";
import { NativeBackend } from "../src/native-backend.ts";
import { NATIVE_DESCRIPTORS } from "../src/native-catalog.ts";
import { mergeNativeSettings } from "../src/native-merge.ts";

async function fixture(
  run: (backend: NativeBackend, agent: string, cwd: string) => Promise<void>,
  options: {
    trusted?: boolean;
    hostSettings?: () => Record<string, JsonValue>;
    applyTheme?: (theme: string) => { success: boolean };
  } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-native-"));
  const agent = join(directory, "agent");
  const cwd = join(directory, "project");
  await mkdir(agent);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const backend = new NativeBackend({
    context: { cwd, isProjectTrusted: () => options.trusted ?? true },
    agentDirectory: () => agent,
    ...(options.hostSettings ? { hostSettings: options.hostSettings } : {}),
    ...(options.applyTheme ? { applyTheme: options.applyTheme } : {}),
  });
  try {
    await run(backend, agent, cwd);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function valid(schema: ValueSchema): JsonValue {
  switch (schema.kind) {
    case "json":
      return null;
    case "boolean":
      return true;
    case "text":
      return "synthetic";
    case "number":
      return schema.minimum ?? 1;
    case "choice":
      return schema.values[0] ?? null;
    case "union":
      return valid(schema.variants[0] as ValueSchema);
    case "list":
      return [];
    case "map":
      return {};
    case "structured":
      return Object.fromEntries(
        Object.entries(schema.fields)
          .filter(([, field]) => field.required)
          .map(([name, field]) => [name, valid(field.schema)]),
      );
  }
}
function invalid(schema: ValueSchema): JsonValue {
  if (schema.kind === "map" || schema.kind === "structured") return [];
  if (schema.kind === "list") return "not-a-list";
  return { invalid: true };
}

async function transaction(
  backend: NativeBackend,
  id: string,
  value: JsonValue,
  scope: "user" | "project" = "user",
): Promise<EditTransaction> {
  const current = await backend.read(id, scope);
  if (current.state !== "available")
    throw new Error("Synthetic fixture unavailable.");
  return {
    descriptorId: id,
    scope,
    expectedRevision: current.revision,
    operation: "set",
    value,
  };
}

test("native reads show defaults, nested inheritance and baseline host merge semantics", async () => {
  await fixture(async (backend, agent, cwd) => {
    const user = {
      theme: "system",
      retry: { maxRetries: 3, provider: { timeoutMs: 100 } },
      compaction: {
        modelOverrides: {
          "synthetic/model": { reserveTokens: 10, keepRecentTokens: 20 },
        },
      },
      defaultProjectTrust: "never",
      httpProxy: "https://example.invalid",
      cacheWarming: "off",
    };
    const project = {
      retry: { provider: { maxRetries: 1 } },
      compaction: {
        modelOverrides: { "synthetic/model": { keepRecentTokens: 30 } },
      },
      defaultProjectTrust: "always",
      httpProxy: "https://project.invalid",
      cacheWarming: "idle",
    };
    await writeFile(join(agent, "settings.json"), JSON.stringify(user));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
    const host = SettingsManager.fromStorage({
      withLock(scope, callback) {
        callback(JSON.stringify(scope === "global" ? user : project));
      },
    });
    const merged = mergeNativeSettings(user, project);
    expect(merged.retry as unknown).toEqual(host.getSettings().retry);
    expect(merged.compaction as unknown).toEqual(host.getSettings().compaction);
    expect(merged.defaultProjectTrust).toBe(host.getDefaultProjectTrust());
    expect(merged.httpProxy).toBe(user.httpProxy);
    expect(merged.cacheWarming).toBe(user.cacheWarming);
    const read = await backend.read(
      "native.retry.provider.timeoutMs",
      "project",
    );
    expect(read.state).toBe("available");
    if (read.state === "available") {
      expect(read.configured.present).toBe(false);
      expect(read.effective).toEqual({ known: true, value: 100 });
      expect(read.provenance.source).toBe("user");
    }
    const defaults = await backend.read("native.compaction.enabled", "user");
    if (defaults.state !== "available") throw new Error("Missing defaults");
    expect(defaults.effective).toEqual({ known: true, value: true });
    expect(defaults.provenance.source).toBe("default");
    expect((await backend.read("native.httpProxy", "project")).state).toBe(
      "unavailable",
    );
  });
});

test("resource declarations preserve expressions and both host loader layers", async () => {
  await fixture(async (backend, agent, cwd) => {
    const user = {
      extensions: ["user.ts", "!excluded/**", "+builtin:mcp"],
      packages: [
        { source: "npm:synthetic", autoload: false, skills: ["+skill.md"] },
      ],
      defaultTools: ["read", "+grep"],
    };
    const project = {
      extensions: ["project.ts", "-builtin:mcp"],
      packages: ["./synthetic"],
      defaultTools: ["-read", "+write"],
    };
    await writeFile(join(agent, "settings.json"), JSON.stringify(user));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
    const host = SettingsManager.fromStorage({
      withLock(scope, callback) {
        callback(JSON.stringify(scope === "global" ? user : project));
      },
    });
    const resources = await backend.read("native.extensions", "user");
    if (resources.state !== "available") throw new Error("Missing resources");
    expect(resources.effective).toEqual({
      known: true,
      value: [
        ...(host.getProjectSettings().extensions ?? []),
        ...(host.getGlobalSettings().extensions ?? []),
      ],
    });
    const tools = await backend.read("native.defaultTools", "user");
    if (tools.state !== "available") throw new Error("Missing tools");
    expect(tools.effective).toEqual({
      known: true,
      value: host.getDefaultTools() ?? [],
    });
  });
});

test("untrusted project files are unavailable and never read for user inheritance", async () => {
  await fixture(
    async (backend, _agent, cwd) => {
      await writeFile(
        join(cwd, ".pi", "settings.json"),
        "malformed-synthetic-secret",
      );
      expect((await backend.read("native.theme", "user")).state).toBe(
        "available",
      );
      expect((await backend.read("native.theme", "project")).state).toBe(
        "unavailable",
      );
      const user = await transaction(backend, "native.theme", "synthetic");
      expect((await backend.write({ ...user, scope: "project" })).state).toBe(
        "rejected",
      );
    },
    { trusted: false },
  );
});

test("every descriptor accepts a valid value, rejects invalid values, and autosaves in temporary configuration", async () => {
  await fixture(async (backend) => {
    for (const descriptor of NATIVE_DESCRIPTORS) {
      const request = await transaction(
        backend,
        descriptor.id,
        valid(descriptor.schema),
      );
      expect((await backend.validate(request)).valid).toBe(true);
      expect((await backend.write(request)).state).toBe("persisted");
      const invalidRequest = await transaction(
        backend,
        descriptor.id,
        invalid(descriptor.schema),
      );
      expect((await backend.validate(invalidRequest)).valid).toBe(false);
      expect((await backend.write(invalidRequest)).state).toBe("rejected");
    }
  });
});

test("map entries merge independently, budgets/packages validate, and reset restores inherited fields", async () => {
  await fixture(async (backend, agent, cwd) => {
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        compaction: {
          modelOverrides: {
            "synthetic/model": { reserveTokens: 10, keepRecentTokens: 20 },
            other: { reserveTokens: 30 },
          },
        },
      }),
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        compaction: {
          modelOverrides: { "synthetic/model": { keepRecentTokens: 40 } },
        },
      }),
    );
    const field = backend.entryDescriptor("native.compaction.modelOverrides", [
      "synthetic/model",
      "keepRecentTokens",
    ]);
    const read = await backend.read(field.id, "project");
    if (read.state !== "available") throw new Error("Missing model override");
    expect(read.effective).toEqual({ known: true, value: 40 });
    expect(
      (
        await backend.removeOverride({
          descriptorId: field.id,
          scope: "project",
          expectedRevision: read.revision,
          operation: "remove-override",
        })
      ).state,
    ).toBe("persisted");
    const inherited = await backend.read(field.id, "project");
    if (inherited.state !== "available") throw new Error("Missing inheritance");
    expect(inherited.effective).toEqual({ known: true, value: 20 });
    expect(inherited.provenance.source).toBe("user");
    const entry = backend.entryDescriptor("native.compaction.modelOverrides", [
      "synthetic/model",
    ]);
    expect(
      (
        await backend.write(
          await transaction(backend, entry.id, { reserveTokens: -1 }),
        )
      ).state,
    ).toBe("rejected");
    expect(
      (
        await backend.write(
          await transaction(backend, "native.thinkingBudgets.high", 1234),
        )
      ).state,
    ).toBe("persisted");
    expect(
      (
        await backend.write(
          await transaction(backend, "native.packages", [
            { source: "npm:synthetic", autoload: false, skills: ["+skill"] },
          ]),
        )
      ).state,
    ).toBe("persisted");
    const before = await readFile(join(agent, "settings.json"), "utf8");
    // Cancelling an incomplete entry does not invoke a transaction.
    const incompleteDraft = { source: "" };
    expect(incompleteDraft.source).toBe("");
    expect(await readFile(join(agent, "settings.json"), "utf8")).toBe(before);
  });
});

test("host/session snapshot differences are distinguished without persisting or selecting a session model", async () => {
  await fixture(
    async (backend) => {
      const read = await backend.read("native.defaultModel", "user");
      if (read.state !== "available") throw new Error("Missing host snapshot");
      expect(read.provenance.source).toBe("host-override");
      expect(read.effective).toEqual({ known: true, value: "session-model" });
      const result = await backend.write(
        await transaction(backend, "native.defaultModel", "startup-model"),
      );
      expect(result.state).toBe("persisted");
      if (result.state !== "persisted")
        throw new Error("Missing acknowledgement");
      expect(result.read.configured).toEqual({
        present: true,
        value: "startup-model",
      });
      expect(result.read.effective).toEqual({
        known: true,
        value: "session-model",
      });
      expect(result.activation).toEqual({
        state: "required",
        requirement: "reload",
      });
    },
    { hostSettings: () => ({ defaultModel: "session-model" }) },
  );
});
