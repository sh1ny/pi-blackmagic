import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CenterCatalog } from "../src/center-catalog.ts";
import type {
  EditResult,
  EditTransaction,
  JsonValue,
  Scope,
  ScopedReadResult,
  SettingDescriptor,
  ValueSchema,
} from "../src/contracts.ts";
import { descriptorCoverage, missingCoverage } from "../src/coverage.ts";
import { KEYBINDING_DESCRIPTORS } from "../src/keybindings-catalog.ts";
import { NATIVE_DESCRIPTORS } from "../src/native-catalog.ts";
import { NativeBackend } from "../src/native-backend.ts";
import { entryRevision } from "../src/persistence.ts";
import { SETTINGS_CHANNELS } from "../src/registration.ts";
import { SettingsRegistry } from "../src/registry.ts";
import { MetadataSearchIndex } from "../src/search.ts";
import {
  type CenterRow,
  SettingsCenterController,
} from "../src/ui-controller.ts";
import fixture from "./fixtures/pi-0.99.1-coverage.json";
import {
  persisted,
  SyntheticBus,
  syntheticExtension,
} from "./fixtures/synthetic-extension.ts";

function available(read: ScopedReadResult) {
  if (read.state !== "available") throw new Error("Expected available read.");
  return read;
}
function value(read: ScopedReadResult): JsonValue {
  const result = available(read);
  if (!result.configured.present) throw new Error("Expected configured value.");
  return result.configured.value;
}
function transaction(
  row: CenterRow,
  revision: string,
  draft: JsonValue,
  scope: Scope = "user",
): EditTransaction {
  return {
    descriptorId: row.descriptor.id,
    scope,
    expectedRevision: revision,
    operation: "set",
    value: draft,
  };
}
function reset(
  row: CenterRow,
  revision: string,
  scope: Scope = "user",
): EditTransaction {
  return {
    descriptorId: row.descriptor.id,
    scope,
    expectedRevision: revision,
    operation: "remove-override",
  };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("settings center storage catalog (synthetic files and event bus only)", () => {
  let temporary: string;
  let agent: string;
  let project: string;
  let trusted: boolean;
  let registry: SettingsRegistry;
  let bus: SyntheticBus;
  let catalog: CenterCatalog;
  let changes: number;
  const restore: (() => void)[] = [];
  async function put(kind: string, root: JsonValue, scope: Scope = "user") {
    const directory = scope === "user" ? agent : join(project, ".pi");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, `${kind}.json`), JSON.stringify(root));
  }
  async function stored(kind: string, scope: Scope = "user") {
    return JSON.parse(
      await fs.readFile(
        join(scope === "user" ? agent : join(project, ".pi"), `${kind}.json`),
        "utf8",
      ),
    );
  }
  function row(id: string): CenterRow {
    const result = catalog.rows().find((entry) => entry.descriptor.id === id);
    if (!result) throw new Error(`Missing row: ${id}`);
    return result;
  }
  function namedRow(
    kind: "MCP" | "Models",
    name: string,
    rename = false,
  ): CenterRow {
    const noun = kind === "MCP" ? "server" : "provider";
    const label = rename
      ? `Rename ${noun}: ${name}`
      : `${kind === "MCP" ? "Server" : "Provider"}: ${name}`;
    const result = catalog
      .rows()
      .find(
        (entry) =>
          entry.descriptor.pageId === kind && entry.descriptor.label === label,
      );
    if (!result) throw new Error(`Missing row: ${label}`);
    return result;
  }
  async function create(
    kind: "mcp" | "models",
    name: string,
    definition: JsonValue,
  ): Promise<EditResult> {
    const add = row(`${kind}:add-${kind === "mcp" ? "server" : "provider"}`);
    return add.write(
      transaction(add, available(await add.read("user")).revision, {
        name,
        definition,
      }),
    );
  }
  beforeEach(async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), "pi-settings-center-catalog-"));
    agent = join(temporary, "agent");
    project = join(temporary, "project");
    trusted = true;
    changes = 0;
    bus = new SyntheticBus();
    registry = new SettingsRegistry(bus);
    catalog = new CenterCatalog({
      context: { cwd: project, isProjectTrusted: () => trusted },
      agentDirectory: () => agent,
      hostSettings: () => ({ theme: "host-theme" }),
      keybindings: {
        getEffectiveConfig: () => ({ "app.interrupt": "ctrl+x" }),
      },
      registry,
      onChange: () => {
        changes++;
      },
    });
  });
  afterEach(async () => {
    for (const callback of restore.splice(0)) callback();
    catalog.dispose();
    registry.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  test("fixed reviewed rows, absent drafts and refresh never create configuration files", async () => {
    expect(
      catalog
        .rows()
        .filter((entry) => entry.descriptor.providerId === "native"),
    ).toHaveLength(NATIVE_DESCRIPTORS.length);
    expect(catalog.rows().filter((entry) => entry.keyCapture)).toHaveLength(
      KEYBINDING_DESCRIPTORS.length,
    );
    const fixed = [...catalog.rows()];
    await catalog.refresh();
    for (const entry of fixed) expect(row(entry.descriptor.id)).toBe(entry);
    for (const id of ["mcp:add-server", "models:add-provider"]) {
      const add = row(id);
      expect(add.initialValue).toEqual({ name: "", definition: {} });
      expect(available(await add.read("user"))).toMatchObject({
        configured: { present: false },
        effective: { known: false },
        revision: entryRevision({ present: false }),
      });
    }
    expect(await fs.readdir(temporary)).toEqual([]);
    expect(changes).toBe(1);
  });

  test("every reviewed backing schema path is reachable and searchable even with no configured names", async () => {
    await catalog.refresh();
    const descriptors = catalog.rows().map((entry) => entry.descriptor);
    const backingDefinitions: SettingDescriptor[] = [
      ...descriptors.filter(
        (entry) =>
          entry.providerId === "native" || entry.providerId === "keybindings",
      ),
      row("mcp:autoEnableCodemode").descriptor,
    ];
    for (const [id, path] of [
      ["mcp:add-server", "mcpServers"],
      ["models:add-provider", "providers"],
    ] as const) {
      const add = row(id).descriptor;
      expect(add.schema.kind).toBe("structured");
      if (add.schema.kind !== "structured")
        throw new Error("Expected creation wrapper.");
      expect(add.schema.fields.name?.schema).toEqual({
        kind: "text",
        minLength: 1,
      });
      expect(add.schema.fields.definition?.required).toBe(true);
      backingDefinitions.push({
        ...add,
        path: [path, "*"],
        schema: add.schema.fields.definition?.schema as ValueSchema,
      });
    }
    const coverage = descriptorCoverage(backingDefinitions);
    const index = new MetadataSearchIndex(descriptors);
    expect(row("models:add-provider").descriptor.description).toBe(
      "Add provider",
    );
    expect(row("mcp:add-server").descriptor.description).toBe("Add server");
    expect(descriptors.every((entry) => entry.description.length < 1024)).toBe(
      true,
    );
    for (const group of [
      fixture.native,
      fixture.keybindings,
      fixture.mcp,
      fixture.models,
    ]) {
      expect(missingCoverage(group, coverage)).toEqual([]);
      for (const path of group)
        expect(index.search(path).length, path).toBeGreaterThan(0);
    }
    expect(
      index
        .search("Input token threshold")
        .some((match) => match.descriptor.id === "models:add-provider"),
    ).toBe(true);
    expect(
      index
        .search("OAuth client settings")
        .some((match) => match.descriptor.id === "mcp:add-server"),
    ).toBe(true);
  });

  test("native rows use host snapshots, scoped revisions, write and remove adapters", async () => {
    const theme = catalog
      .rows()
      .find(
        (entry) => entry.descriptor.path.join(".") === "theme",
      ) as CenterRow;
    expect(available(await theme.read("user")).provenance.source).toBe(
      "host-override",
    );
    const setting = catalog
      .rows()
      .find(
        (entry) => entry.descriptor.path.join(".") === "editorPaddingX",
      ) as CenterRow;
    const baseline = available(await setting.read("user"));
    expect(
      (await setting.write(transaction(setting, baseline.revision, 2))).state,
    ).toBe("persisted");
    expect((await stored("settings")).editorPaddingX).toBe(2);
    expect(
      (
        await setting.removeOverride?.(
          reset(setting, available(await setting.read("user")).revision),
        )
      )?.state,
    ).toBe("persisted");
    expect(Object.hasOwn(await stored("settings"), "editorPaddingX")).toBe(
      false,
    );
  });

  test("key capture rows use action adapters and expose contextual warnings without rejecting collisions", async () => {
    const binding = catalog
      .rows()
      .find(
        (entry) => entry.descriptor.path[0] === "app.interrupt",
      ) as CenterRow;
    expect(binding.keyCapture).toBe(true);
    expect(available(await binding.read("user")).effective).toEqual({
      known: true,
      value: "ctrl+x",
    });
    await put("keybindings", {
      "app.exit": "enter",
      "tui.editor.submit": "enter",
    });
    const warnings = await catalog.keybindingWarnings(
      binding.descriptor.id,
      "enter",
    );
    expect(warnings.some((warning) => warning.overlap === "same-context")).toBe(
      true,
    );
    expect(
      warnings.some((warning) => warning.overlap === "context-dependent"),
    ).toBe(true);
    const advisory = await binding.warnings?.(
      transaction(
        binding,
        available(await binding.read("user")).revision,
        "enter",
      ),
    );
    expect(advisory?.some((warning) => warning.startsWith("app.exit:"))).toBe(
      true,
    );
    expect(advisory?.every((warning) => !warning.includes("synthetic"))).toBe(
      true,
    );
    expect(
      (
        await binding.write(
          transaction(
            binding,
            available(await binding.read("user")).revision,
            "enter",
          ),
        )
      ).state,
    ).toBe("persisted");
    expect((await stored("keybindings"))["app.interrupt"]).toBe("enter");
    expect(
      (
        await binding.removeOverride?.(
          reset(binding, available(await binding.read("user")).revision),
        )
      )?.state,
    ).toBe("persisted");
    expect((await binding.read("project")).state).toBe("unavailable");
  });

  test("MCP root option supports set and override removal", async () => {
    const option = row("mcp:autoEnableCodemode");
    expect(available(await option.read("user")).effective).toEqual({
      known: true,
      value: true,
    });
    expect(
      (
        await option.write(
          transaction(
            option,
            available(await option.read("user")).revision,
            false,
          ),
        )
      ).state,
    ).toBe("persisted");
    expect((await stored("mcp")).autoEnableCodemode).toBe(false);
    expect(
      (
        await option.removeOverride?.(
          reset(option, available(await option.read("user")).revision),
        )
      )?.state,
    ).toBe("persisted");
    expect(available(await option.read("user")).effective).toEqual({
      known: true,
      value: true,
    });
  });

  test("named servers are discovered in allowed scopes, masked, stable and independently revisioned", async () => {
    await put("mcp", {
      mcpServers: {
        alpha: { command: "literal", env: { TOKEN: "synthetic-secret" } },
        userOnly: { command: "user" },
      },
    });
    await put(
      "mcp",
      {
        mcpServers: {
          alpha: { url: "https://example.invalid/mcp" },
          projectOnly: { command: "project" },
        },
      },
      "project",
    );
    await catalog.refresh();
    const alpha = namedRow("MCP", "alpha");
    const rename = namedRow("MCP", "alpha", true);
    const baseline = available(await alpha.read("user"));
    expect(JSON.stringify(baseline)).not.toContain("synthetic-secret");
    expect(available(await rename.read("user")).revision).toBe(
      baseline.revision,
    );
    expect(value(await rename.read("user"))).toBe("alpha");
    expect(alpha.descriptor.scopes).toEqual(["user", "project"]);
    expect(namedRow("MCP", "userOnly")).toBeDefined();
    expect(namedRow("MCP", "projectOnly")).toBeDefined();
    await put("mcp", {
      mcpServers: {
        alpha: { command: "externally-updated" },
        userOnly: { command: "user" },
      },
    });
    await catalog.refresh();
    expect(namedRow("MCP", "alpha")).toBe(alpha);
    expect(namedRow("MCP", "alpha", true)).toBe(rename);
    expect(
      (
        await alpha.write(
          transaction(alpha, baseline.revision, { command: "stale" }),
        )
      ).state,
    ).toBe("rejected");
  });

  test("server create, edit, rename, collision and delete refresh the catalog automatically", async () => {
    expect((await create("mcp", "alpha", { command: "literal" })).state).toBe(
      "persisted",
    );
    expect((await create("mcp", "beta", { command: "other" })).state).toBe(
      "persisted",
    );
    const alpha = namedRow("MCP", "alpha");
    const beta = namedRow("MCP", "beta");
    expect(
      (
        await alpha.write(
          transaction(alpha, available(await alpha.read("user")).revision, {
            command: "changed",
            args: ["one"],
          }),
        )
      ).state,
    ).toBe("persisted");
    expect(namedRow("MCP", "alpha")).toBe(alpha);
    expect(namedRow("MCP", "beta")).toBe(beta);
    const rename = namedRow("MCP", "alpha", true);
    expect(
      await rename.write(
        transaction(
          rename,
          available(await rename.read("user")).revision,
          "beta",
        ),
      ),
    ).toMatchObject({ state: "rejected", reason: "conflict" });
    const renamed = await rename.write(
      transaction(
        rename,
        available(await rename.read("user")).revision,
        "gamma",
      ),
    );
    expect(renamed.state).toBe("persisted");
    if (renamed.state === "persisted")
      expect(renamed.read.configured).toEqual({
        present: true,
        value: "gamma",
      });
    expect(catalog.rows()).not.toContain(alpha);
    const gamma = namedRow("MCP", "gamma");
    expect(
      (
        await gamma.delete?.(
          "user",
          available(await gamma.read("user")).revision,
        )
      )?.state,
    ).toBe("persisted");
    expect(catalog.rows()).not.toContain(gamma);
    expect(namedRow("MCP", "beta")).toBe(beta);
    expect((await stored("mcp")).mcpServers).toEqual({
      beta: { command: "other" },
    });
  });

  test("project server removal reveals inherited entries and only removes project-only names", async () => {
    await put("mcp", { mcpServers: { shared: { command: "user" } } });
    await put(
      "mcp",
      {
        mcpServers: {
          shared: { command: "project" },
          local: { command: "local" },
        },
      },
      "project",
    );
    await catalog.refresh();
    const shared = namedRow("MCP", "shared");
    expect(
      (
        await shared.removeOverride?.(
          reset(
            shared,
            available(await shared.read("project")).revision,
            "project",
          ),
        )
      )?.state,
    ).toBe("persisted");
    expect(namedRow("MCP", "shared")).toBe(shared);
    expect(available(await shared.read("project")).effective).toEqual({
      known: true,
      value: { command: "user" },
    });
    const local = namedRow("MCP", "local");
    await local.delete?.(
      "project",
      available(await local.read("project")).revision,
    );
    expect(catalog.rows()).not.toContain(local);
  });

  test("provider structured writes coherently add/edit/rename/delete nested models and overrides", async () => {
    expect(
      (
        await create("models", "alpha", {
          baseUrl: "https://example.invalid",
          models: [{ id: "old", contextWindow: 10 }],
          modelOverrides: { old: { maxTokens: 5 } },
        })
      ).state,
    ).toBe("persisted");
    const provider = namedRow("Models", "alpha");
    expect(provider.descriptor.scopes).toEqual(["user"]);
    expect((await provider.read("project")).state).toBe("unavailable");
    const draft = {
      baseUrl: "https://example.invalid",
      models: [
        { id: "renamed", contextWindow: 20 },
        { id: "added", maxTokens: 10 },
      ],
      modelOverrides: {
        renamed: { maxTokens: 15, compat: { supportsStore: false } },
        added: { contextWindow: 30 },
      },
    };
    expect(
      (
        await provider.write(
          transaction(
            provider,
            available(await provider.read("user")).revision,
            draft,
          ),
        )
      ).state,
    ).toBe("persisted");
    expect(value(await provider.read("user"))).toEqual(draft);
    expect(namedRow("Models", "alpha")).toBe(provider);
    const deleted = {
      baseUrl: "https://example.invalid",
      models: [{ id: "added", maxTokens: 10 }],
      modelOverrides: { added: { contextWindow: 30 } },
    };
    expect(
      (
        await provider.write(
          transaction(
            provider,
            available(await provider.read("user")).revision,
            deleted,
          ),
        )
      ).state,
    ).toBe("persisted");
    expect((await stored("models")).providers.alpha).toEqual(deleted);
    const rename = namedRow("Models", "alpha", true);
    expect(available(await rename.read("user")).revision).toBe(
      available(await provider.read("user")).revision,
    );
    expect(
      (
        await rename.write(
          transaction(
            rename,
            available(await rename.read("user")).revision,
            "beta",
          ),
        )
      ).state,
    ).toBe("persisted");
    expect(catalog.rows()).not.toContain(provider);
    const beta = namedRow("Models", "beta");
    expect(
      (await beta.delete?.("user", available(await beta.read("user")).revision))
        ?.state,
    ).toBe("persisted");
    expect(catalog.rows()).not.toContain(beta);
  });

  test("provider rename collision never replaces a destination", async () => {
    await create("models", "alpha", { baseUrl: "https://alpha.invalid" });
    await create("models", "beta", { baseUrl: "https://beta.invalid" });
    const rename = namedRow("Models", "alpha", true);
    expect(
      await rename.write(
        transaction(
          rename,
          available(await rename.read("user")).revision,
          "beta",
        ),
      ),
    ).toMatchObject({ state: "rejected", reason: "conflict" });
    expect((await stored("models")).providers.beta).toEqual({
      baseUrl: "https://beta.invalid",
    });
  });

  test("add drafts keep absent-entry revisions and cannot overwrite a configured destination", async () => {
    for (const kind of ["mcp", "models"] as const) {
      const definition =
        kind === "mcp"
          ? { command: "original" }
          : { baseUrl: "https://original.invalid" };
      await create(kind, "existing", definition);
      const add = row(`${kind}:add-${kind === "mcp" ? "server" : "provider"}`);
      const baseline = available(await add.read("user"));
      expect(baseline.revision).toBe(entryRevision({ present: false }));
      expect(
        await add.write(
          transaction(add, baseline.revision, { name: "existing", definition }),
        ),
      ).toMatchObject({ state: "rejected", reason: "conflict" });
      const configured = namedRow(
        kind === "mcp" ? "MCP" : "Models",
        "existing",
      );
      expect(
        await add.write(
          transaction(add, available(await configured.read("user")).revision, {
            name: "existing",
            definition,
          }),
        ),
      ).toMatchObject({ state: "rejected", reason: "conflict" });
      const created = await create(kind, "new", definition);
      expect(created.state).toBe("persisted");
      if (created.state === "persisted")
        expect(created.read.configured).toEqual({ present: false });
      expect(value(await configured.read("user"))).toEqual(definition);
    }
  });

  test("create reads and dynamic discovery do not hide malformed or invalid backing files", async () => {
    await fs.mkdir(agent, { recursive: true });
    for (const [kind, id, invalid] of [
      ["mcp", "mcp:add-server", { mcpServers: { bad: { timeout: -1 } } }],
      [
        "models",
        "models:add-provider",
        { providers: { bad: { models: "not-a-list" } } },
      ],
    ] as const) {
      await fs.writeFile(join(agent, `${kind}.json`), "{broken");
      expect((await row(id).read("user")).state).toBe("error");
      await put(kind, invalid);
      expect((await row(id).read("user")).state).toBe("error");
      await catalog.refresh();
      expect(
        catalog
          .rows()
          .some((entry) => entry.descriptor.label.endsWith(": bad")),
      ).toBe(false);
    }
  });

  test("untrusted discovery and project row operations never read project files", async () => {
    await put("mcp", { mcpServers: { user: { command: "literal" } } });
    await put(
      "mcp",
      { mcpServers: { hidden: { command: "literal" } } },
      "project",
    );
    trusted = false;
    const original = fs.readFile;
    const reads: string[] = [];
    const spy = spyOn(fs, "readFile").mockImplementation(((
      ...args: Parameters<typeof fs.readFile>
    ) => {
      reads.push(String(args[0]));
      return original(...args);
    }) as typeof fs.readFile);
    restore.push(() => spy.mockRestore());
    await catalog.refresh();
    expect(
      catalog.rows().some((entry) => entry.descriptor.label.includes("hidden")),
    ).toBe(false);
    expect((await row("mcp:add-server").read("project")).state).toBe(
      "unavailable",
    );
    expect((await namedRow("MCP", "user").read("project")).state).toBe(
      "unavailable",
    );
    expect(
      (
        await namedRow("MCP", "user").write(
          transaction(
            namedRow("MCP", "user"),
            entryRevision({ present: false }),
            { command: "no" },
            "project",
          ),
        )
      ).state,
    ).toBe("rejected");
    expect(reads.some((path) => path.startsWith(project))).toBe(false);
    expect(reads.some((path) => path.startsWith(agent))).toBe(true);
  });

  test("discovery discards project contents when trust is revoked during a permitted read", async () => {
    await put(
      "mcp",
      { mcpServers: { revoked: { command: "literal" } } },
      "project",
    );
    const original = fs.readFile;
    const spy = spyOn(fs, "readFile").mockImplementation(((
      ...args: Parameters<typeof fs.readFile>
    ) => {
      const result = original(...args);
      if (String(args[0]) === join(project, ".pi", "mcp.json")) trusted = false;
      return result;
    }) as typeof fs.readFile);
    restore.push(() => spy.mockRestore());
    await catalog.refresh();
    expect(
      catalog
        .rows()
        .some((entry) => entry.descriptor.label.includes("revoked")),
    ).toBe(false);
    expect((await row("mcp:add-server").read("project")).state).toBe(
      "unavailable",
    );
  });

  test("refresh removes previously discovered project-only names when trust is revoked", async () => {
    await put(
      "mcp",
      { mcpServers: { privateProject: { command: "literal" } } },
      "project",
    );
    await catalog.refresh();
    const previous = namedRow("MCP", "privateProject");
    trusted = false;
    await catalog.refresh();
    expect(catalog.rows()).not.toContain(previous);
    expect((await previous.read("project")).state).toBe("unavailable");
  });

  test("metadata never indexes configuration values, control characters or secret URLs in names", async () => {
    const unsafe =
      "https://user:synthetic-secret@example.invalid/provider\u001b";
    await put("models", {
      providers: {
        [unsafe]: {
          apiKey: "synthetic-key",
          baseUrl: "https://private.invalid",
          modelOverrides: {
            privateModel: { headers: { Authorization: "synthetic-token" } },
          },
        },
      },
    });
    await put("mcp", {
      mcpServers: {
        ordinary: {
          command: "literal-secret-command",
          env: { TOKEN: "synthetic-env" },
        },
      },
    });
    await catalog.refresh();
    const descriptors = catalog.rows().map((entry) => entry.descriptor);
    const index = new MetadataSearchIndex(descriptors);
    for (const secret of [
      "synthetic-secret",
      "synthetic-key",
      "private.invalid",
      "privateModel",
      "synthetic-token",
      "literal-secret-command",
      "synthetic-env",
    ])
      expect(index.search(secret)).toEqual([]);
    expect(
      descriptors
        .flatMap((entry) => entry.searchTerms ?? [])
        .some((term) => term.includes("ordinary")),
    ).toBe(false);
    const metadataOnly = descriptors.map(
      ({ schema: _schema, ...rest }) => rest,
    );
    expect(JSON.stringify(metadataOnly)).not.toContain("\\u001b");
    expect(JSON.stringify(metadataOnly)).not.toContain(unsafe);
    const provider = catalog
      .rows()
      .find(
        (entry) =>
          entry.descriptor.pageId === "Models" && Boolean(entry.delete),
      ) as CenterRow;
    expect(provider.descriptor.path).toEqual(["providers", "Private metadata"]);
    expect(
      index.search("providers.*.modelOverrides.*.compat.supportsStore").length,
    ).toBeGreaterThan(0);
    expect(
      (
        await provider.delete?.(
          "user",
          available(await provider.read("user")).revision,
        )
      )?.state,
    ).toBe("persisted");
  });

  test("registry rows are global, callback-free during refresh and scoped/validated only by the registry", async () => {
    const provider = syntheticExtension(bus);
    expect(
      catalog
        .rows()
        .some((entry) => entry.descriptor.id === "synthetic.advanced.enabled"),
    ).toBe(true);
    await catalog.refresh();
    const extension = row("synthetic.advanced.enabled");
    expect(extension.descriptor.sourceLabel).toBe(
      "Extensions / Synthetic tools / Advanced behavior",
    );
    expect(provider.calls).toEqual({
      read: 0,
      validate: 0,
      write: 0,
      remove: 0,
    });
    await catalog.refresh();
    expect(row(extension.descriptor.id)).toBe(extension);
    expect((await extension.read("project")).state).toBe("unavailable");
    expect(
      await extension.write(transaction(extension, "0", "wrong-type")),
    ).toMatchObject({ state: "rejected", reason: "validation" });
    expect(provider.calls.write).toBe(0);
    expect(
      (
        await extension.write(
          transaction(
            extension,
            available(await extension.read("user")).revision,
            true,
          ),
        )
      ).state,
    ).toBe("persisted");
    expect(provider.calls.validate).toBe(1);
    expect(provider.calls.write).toBe(1);
    provider.cleanup();
    expect(catalog.rows()).not.toContain(extension); // Synchronous, before filesystem refresh.
    await catalog.refresh();
    expect(catalog.rows()).not.toContain(extension);
    expect((await extension.read("user")).state).toBe("unavailable");
  });

  test("callback-only registration replacements invalidate captured generations; ordinary refresh does not", async () => {
    const provider = syntheticExtension(bus);
    await catalog.refresh();
    const previous = row("synthetic.advanced.enabled");
    let replacementCalls = 0;
    bus.emit(SETTINGS_CHANNELS.register, {
      ...provider.payload,
      operations: {
        ...provider.payload.operations,
        async write() {
          replacementCalls++;
          return persisted();
        },
      },
    });
    await catalog.refresh();
    const replacement = row(previous.descriptor.id);
    expect(replacement).not.toBe(previous);
    expect((await previous.write(transaction(previous, "0", true))).state).toBe(
      "rejected",
    );
    expect(replacementCalls).toBe(0);
    expect(
      (await replacement.write(transaction(replacement, "0", true))).state,
    ).toBe("persisted");
    expect(replacementCalls).toBe(1);
    await catalog.refresh();
    expect(row(replacement.descriptor.id)).toBe(replacement);
  });

  test("extension reset is not inferred from registry's unconditional operations wrapper", async () => {
    const provider = syntheticExtension();
    const { removeOverride: _remove, ...operations } =
      provider.payload.operations;
    bus.emit(SETTINGS_CHANNELS.register, { ...provider.payload, operations });
    await catalog.refresh();
    expect(registry.operations("synthetic")?.removeOverride).toBeDefined();
    expect(row("synthetic.advanced.enabled").removeOverride).toBeUndefined();
  });

  test("extension reset is exposed only when public provider capability confirms support", async () => {
    const provider = syntheticExtension(bus);
    expect(registry.list()[0]?.supportsRemoveOverride).toBe(true);
    await catalog.refresh();
    const extension = row("synthetic.advanced.enabled");
    expect(extension.removeOverride).toBeDefined();
    expect(
      (
        await extension.removeOverride?.(
          reset(extension, available(await extension.read("user")).revision),
        )
      )?.state,
    ).toBe("persisted");
    expect(provider.calls.remove).toBe(1);
    expect(provider.calls.write).toBe(0);
  });

  test("session disposal aborts registry callbacks but does not dispose the host registry", async () => {
    const provider = syntheticExtension();
    let signal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    bus.emit(SETTINGS_CHANNELS.register, {
      ...provider.payload,
      operations: {
        ...provider.payload.operations,
        async read(
          _id: string,
          scope: Scope,
          context: { signal: AbortSignal },
        ) {
          signal = context.signal;
          entered();
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return provider.read(scope);
        },
      },
    });
    await catalog.refresh();
    const extension = row("synthetic.advanced.enabled");
    const pending = extension.read("user");
    await started;
    const previousChanges = changes;
    catalog.dispose();
    expect(signal?.aborted).toBe(true);
    expect((await pending).state).toBe("unavailable");
    await catalog.refresh();
    expect(changes).toBe(previousChanges);
    expect(catalog.rows()).toEqual([]);
    expect(registry.list()).toHaveLength(1);
    expect(
      (await extension.write(transaction(extension, "0", true))).state,
    ).toBe("rejected");
  });

  test("native operations receive the session signal and refresh preserves pending controller acknowledgement", async () => {
    let release!: (result: EditResult) => void;
    let signal: AbortSignal | undefined;
    const pending = new Promise<EditResult>((resolve) => {
      release = resolve;
    });
    const spy = spyOn(NativeBackend.prototype, "write").mockImplementation(
      async (_transaction, context) => {
        signal = context?.signal;
        return pending;
      },
    );
    restore.push(() => spy.mockRestore());
    const setting = catalog
      .rows()
      .find(
        (entry) => entry.descriptor.path.join(".") === "hideThinkingBlock",
      ) as CenterRow;
    const controller = new SettingsCenterController([setting], {
      onChange: () => {},
      onClose: () => {},
      tabs: [setting.descriptor.pageId],
    });
    try {
      await tick();
      controller.handleInput("\r");
      await tick();
      controller.handleInput("\r");
      await tick();
      expect(controller.view().pending).toBe(true);
      await catalog.refresh();
      controller.setRows([row(setting.descriptor.id)]);
      expect(controller.view().pending).toBe(true);
      expect(row(setting.descriptor.id)).toBe(setting);
      release({ state: "failed", message: "synthetic failure" });
      await tick();
      expect(controller.view().status.requiresAcknowledgement).toBe(true);
      await catalog.refresh();
      controller.setRows([row(setting.descriptor.id)]);
      expect(controller.view().status.requiresAcknowledgement).toBe(true);
      catalog.dispose();
      expect(signal?.aborted).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});
