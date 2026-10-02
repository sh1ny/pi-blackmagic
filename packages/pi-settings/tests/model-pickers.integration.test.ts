import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CenterCatalog } from "../src/center-catalog.ts";
import type { JsonValue } from "../src/contracts.ts";
import { SettingsRegistry } from "../src/registry.ts";
import {
  SettingsCenterController,
  type CenterRow,
} from "../src/ui-controller.ts";
import { SyntheticBus } from "./fixtures/synthetic-extension.ts";

const enter = "\r",
  down = "\x1b[B",
  escapeKey = "\x1b";
async function until(condition: () => boolean) {
  for (let index = 0; index < 300; index++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Synthetic model picker did not settle.");
}
async function fixture(
  run: (
    catalog: CenterCatalog,
    agent: string,
    project: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-settings-model-picker-"));
  const agent = join(root, "agent"),
    project = join(root, "project");
  await mkdir(agent);
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({ defaultProvider: "alpha" }),
  );
  await writeFile(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ defaultProvider: "beta" }),
  );
  const registry = new SettingsRegistry(new SyntheticBus());
  const catalog = new CenterCatalog({
    context: { cwd: project, isProjectTrusted: () => true },
    agentDirectory: () => agent,
    registry,
    keybindings: { getEffectiveConfig: () => ({}) },
    hostSettings: () => ({ defaultProvider: "session-only" }),
    onChange: () => {},
    modelCatalog: {
      getAll: () => [
        {
          provider: "alpha",
          id: "small",
          name: "Small model",
          api: "openai-completions",
        },
        {
          provider: "beta",
          id: "large",
          name: "Large model",
          api: "anthropic-messages",
        },
      ],
      getRegisteredProviderIds: () => ["empty"],
    },
  });
  try {
    await catalog.refresh();
    await run(catalog, agent, project);
  } finally {
    catalog.dispose();
    registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
function row(catalog: CenterCatalog, path: string): CenterRow {
  const selected = catalog
    .rows()
    .find(
      (entry) =>
        entry.descriptor.path.length === 1 && entry.descriptor.path[0] === path,
    );
  if (!selected) throw new Error("Missing synthetic model setting.");
  return selected;
}
const context = {
  path: [],
  rootValue: "",
  parentValue: null,
  currentValue: "",
} as const;

test("model choices follow fresh saved provider and correct user/project inheritance without host reload", async () => {
  await fixture(async (catalog, _agent, projectDirectory) => {
    const model = row(catalog, "defaultModel"),
      provider = row(catalog, "defaultProvider");
    const user = await model.editorSuggestions?.("user"),
      project = await model.editorSuggestions?.("project");
    expect(user?.(context)?.map((entry) => entry.value)).toEqual(["small"]);
    expect(project?.(context)?.map((entry) => entry.value)).toEqual(["large"]);
    await writeFile(join(projectDirectory, ".pi", "settings.json"), "{}");
    const inherited = await model.editorSuggestions?.("project");
    expect(inherited?.(context)?.map((entry) => entry.value)).toEqual([
      "small",
    ]);
    const read = await provider.read("user");
    if (read.state !== "available") throw new Error("Missing baseline.");
    const result = await provider.write({
      descriptorId: provider.descriptor.id,
      scope: "user",
      expectedRevision: read.revision,
      operation: "set",
      value: "beta",
    });
    expect(result.state).toBe("persisted");
    const changed = await model.editorSuggestions?.("user");
    expect(changed?.(context)?.map((entry) => entry.value)).toEqual(["large"]);
  });
});

test("default model picker saves exact IDs and Add provider opens the provider list without writing partial drafts", async () => {
  await fixture(async (catalog, agent) => {
    const model = row(catalog, "defaultModel");
    const controller = new SettingsCenterController([model], {
      tabs: ["Models"],
      onChange: () => {},
      onClose: () => {},
    });
    try {
      controller.handleInput(enter);
      await until(() => controller.view().editor !== null);
      expect(
        controller
          .view()
          .editor?.lines.some((line) => line.label.includes("Small model")),
      ).toBe(true);
      expect(
        controller
          .view()
          .editor?.lines.some((line) => line.label.includes("Large model")),
      ).toBe(false);
      controller.handleInput(enter);
      await until(() => controller.view().status.kind === "saved");
      const saved = JSON.parse(
        await readFile(join(agent, "settings.json"), "utf8"),
      );
      expect(saved.defaultModel).toBe("small");
      expect(saved.defaultProvider).toBe("alpha");
    } finally {
      controller.dispose();
    }
    const add = catalog
      .rows()
      .find((entry) => entry.descriptor.id === "models:add-provider");
    if (!add) throw new Error("Missing Add provider.");
    const adding = new SettingsCenterController([add], {
      tabs: ["Models"],
      onChange: () => {},
      onClose: () => {},
    });
    try {
      adding.handleInput(enter);
      await until(() => adding.view().editor !== null);
      expect(adding.view().editor?.path).toEqual(["name"]);
      expect(adding.view().editor?.lines.map((line) => line.label)).toEqual(
        expect.arrayContaining(["alpha", "beta", "empty"]),
      );
      adding.handleInput(down);
      adding.handleInput(enter);
      expect(adding.view().editor?.path).toEqual([]);
      adding.handleInput(escapeKey);
      expect(await Bun.file(join(agent, "models.json")).exists()).toBe(false);
    } finally {
      adding.dispose();
    }
  });
});

test("configured model definitions become selectable after saving without refreshing the credential-resolving host runtime", async () => {
  await fixture(async (catalog) => {
    const add = catalog
      .rows()
      .find((entry) => entry.descriptor.id === "models:add-provider");
    if (!add) throw new Error("Missing Add provider.");
    const baseline = await add.read("user");
    if (baseline.state !== "available") throw new Error("Missing baseline.");
    const definition: JsonValue = {
      baseUrl: "https://example.invalid",
      api: "openai-completions",
      models: [
        {
          id: "new",
          name: "New model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 1024,
        },
      ],
    };
    const result = await add.write({
      descriptorId: add.descriptor.id,
      scope: "user",
      expectedRevision: baseline.revision,
      operation: "set",
      value: { name: "custom", definition },
    });
    expect(result.state).toBe("persisted");
    const choices = await row(catalog, "defaultProvider").editorSuggestions?.(
      "user",
    );
    expect(choices?.(context)?.map((entry) => entry.value)).toContain("custom");
    const provider = catalog
      .rows()
      .find((entry) => entry.descriptor.label === "Provider: custom");
    const fields = await provider?.editorSuggestions?.("user");
    expect(
      fields?.({ ...context, path: ["models", "0", "id"], rootValue: {} })?.map(
        (entry) => entry.value,
      ),
    ).toEqual(["new"]);
    const rename = catalog
      .rows()
      .find((entry) => entry.descriptor.label === "Rename provider: custom");
    const names = await rename?.editorSuggestions?.("user");
    expect(names?.(context)?.map((entry) => entry.value)).toEqual([
      "alpha",
      "beta",
      "custom",
      "empty",
    ]);
  });
});
