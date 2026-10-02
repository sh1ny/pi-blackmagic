import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { descriptorCoverage, missingCoverage } from "../src/coverage.ts";
import {
  BASELINE_VERSION,
  EXCLUDED_NATIVE_FIELDS,
  NATIVE_DESCRIPTORS,
} from "../src/native-catalog.ts";
import { nativeInventory, schemaInventory } from "./baseline-inventory.ts";
import fixture from "./fixtures/pi-0.99.1-coverage.json";
import future from "./fixtures/unknown-future-fields.json";

const host = new URL(
  "../../../node_modules/@earendil-works/pi-coding-agent/",
  import.meta.url,
);
function baseline(path: string): string {
  return readFileSync(new URL(path, host), "utf8");
}

test("reviewed native inventory exactly reconciles with baseline declarations", () => {
  expect(JSON.parse(baseline("package.json")).version).toBe(BASELINE_VERSION);
  const all = nativeInventory(baseline("dist/core/settings-manager.d.ts"));
  expect(all.filter((path) => !fixture.excludedNative.includes(path))).toEqual(
    fixture.native,
  );
  expect([...EXCLUDED_NATIVE_FIELDS].sort() as string[]).toEqual(
    fixture.excludedNative,
  );
  expect(
    missingCoverage(fixture.native, descriptorCoverage(NATIVE_DESCRIPTORS)),
  ).toEqual([]);
});

test("reviewed action catalog contains all host and TUI actions, not migration aliases", () => {
  const tui = readFileSync(
    new URL(
      "../../../node_modules/@earendil-works/pi-tui/dist/keybindings.js",
      import.meta.url,
    ),
    "utf8",
  );
  const sources = [
    baseline("dist/core/keybindings.js").split(
      "const KEYBINDING_NAME_MIGRATIONS",
    )[0] ?? "",
    tui.split("export class")[0] ?? "",
  ];
  const actions = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/"((?:app|tui)\.[^"]+)"\s*:/g)].map(
        (match) => match[1] as string,
      ),
    ),
  );
  expect([...actions].sort()).toEqual(fixture.keybindings);
});

test("reviewed MCP fields cover all baseline entry fields and root options", () => {
  const paths = nativeInventory(
    baseline("dist/core/mcp-servers.d.ts"),
    "McpServerConfig",
    "mcpServers.*",
  );
  expect([...paths, "mcpServers", "autoEnableCodemode"].sort()).toEqual(
    fixture.mcp,
  );
  expect(baseline("dist/extensions/mcp/config.js")).toContain(
    "autoEnableCodemode",
  );
});

test("reviewed provider/model inventory reconciles every nested baseline schema field", () => {
  expect(
    schemaInventory(
      baseline("dist/core/model-config.js"),
      "ModelsConfigSchema",
    ),
  ).toEqual(fixture.models);
});

test("coverage checking detects omission of any reviewed path in every subsystem", () => {
  for (const group of [
    fixture.native,
    fixture.keybindings,
    fixture.mcp,
    fixture.models,
  ]) {
    expect(new Set(group).size).toBe(group.length);
    for (const path of group)
      expect(
        missingCoverage(
          group,
          group.filter((candidate) => candidate !== path),
        ),
      ).toEqual([path]);
  }
});

test("future-field fixtures remain available without inferring editable descriptors", () => {
  expect(future.native.futureNative.enabled).toBe(true);
  expect(future.keybindings["app.future.action"]).toEqual(["ctrl+f12"]);
  expect(future.mcp.mcpServers.synthetic.futureTransportOption).toBe(42);
  expect(future.models.providers.synthetic.models[0]?.futureModelMetadata).toBe(
    "preserve",
  );
  expect(
    NATIVE_DESCRIPTORS.some((entry) => entry.path[0] === "futureNative"),
  ).toBe(false);
});
