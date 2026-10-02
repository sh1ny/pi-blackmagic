import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type {
  SettingsEventBus,
  SettingsOperations,
} from "../src/registration.ts";
import { SettingsRegistry } from "../src/registry.ts";
import { SyntheticBus } from "./fixtures/synthetic-extension.ts";

test("published registration subpath targets side-effect-free source and is in the source allowlist", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    exports: Record<string, string>;
    files: string[];
  };
  expect(manifest.exports["./registration"]).toBe("./src/registration.ts");
  expect(manifest.files).toContain("src");
  expect(manifest.files).not.toContain("tests");
});

test("documented complete raw example discovers, persists, removes and cleans up without package imports", async () => {
  const documentation = await readFile(
    new URL("../docs/registration.md", import.meta.url),
    "utf8",
  );
  const raw = documentation.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(raw).toBeDefined();
  expect(raw).not.toMatch(/\bimport\b/);
  const install = new Function(
    `${raw?.replace("export function", "function")}\nreturn installSettingsProvider;`,
  )() as (bus: SettingsEventBus) => () => void;
  const bus = new SyntheticBus();
  const cleanup = install(bus);
  const registry = new SettingsRegistry(bus);
  const operations = registry.operations("example") as SettingsOperations;
  const context = { signal: new AbortController().signal };
  expect(
    (await operations.read("example.tools.enabled", "user", context)).state,
  ).toBe("available");
  expect(
    (
      await operations.write(
        {
          descriptorId: "example.tools.enabled",
          scope: "user",
          expectedRevision: "0",
          operation: "set",
          value: true,
        },
        context,
      )
    ).state,
  ).toBe("persisted");
  expect(
    (
      await operations.removeOverride?.(
        {
          descriptorId: "example.tools.enabled",
          scope: "user",
          expectedRevision: "1",
          operation: "remove-override",
        },
        context,
      )
    )?.state,
  ).toBe("persisted");
  cleanup();
  cleanup();
  expect(registry.catalog()).toEqual([]);
  registry.dispose();
  expect(bus.count()).toBe(0);
});

test("registry is native-independent and never guesses provider storage paths", async () => {
  const source = await readFile(
    new URL("../src/registry.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toMatch(
    /from\s+["'](?:node:|@earendil|.*native-|.*paths|.*persistence|.*index)/,
  );
  expect(source).not.toMatch(
    /\breadFile\b|\bwriteFile\b|settings\.json|\.pi\//,
  );
});
