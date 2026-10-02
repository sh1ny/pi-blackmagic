import { expect, test } from "bun:test";
import type { SettingDescriptor } from "../src/contracts.ts";
import {
  NATIVE_DEFAULTS,
  NATIVE_DESCRIPTORS,
  NATIVE_PAGES,
} from "../src/native-catalog.ts";
import { MetadataSearchIndex } from "../src/search.ts";

const plugin: SettingDescriptor = {
  id: "synthetic.specialized.enabled",
  providerId: "synthetic",
  pageId: "Specialized",
  path: ["enabled"],
  label: "Synthetic feature",
  description: "Specialized plugin behavior",
  sourceLabel: "Extensions / Synthetic / Specialized",
  schema: { kind: "boolean" },
  scopes: ["user"],
  sensitivity: "public",
  activation: "reload",
};

test("all pages include absent settings and defaults without consulting configuration", () => {
  expect(
    NATIVE_DESCRIPTORS.find((entry) => entry.label === "defaultProvider"),
  ).toBeDefined();
  expect(NATIVE_DEFAULTS.theme).toBe("system");
  for (const page of NATIVE_PAGES) {
    expect(NATIVE_DESCRIPTORS.some((entry) => entry.pageId === page)).toBe(
      true,
    );
  }
  expect(new Set(NATIVE_DESCRIPTORS.map((entry) => entry.id)).size).toBe(
    NATIVE_DESCRIPTORS.length,
  );
});

test("nested overrides and structured fields have descriptions and typed schemas", () => {
  const reserve = NATIVE_DESCRIPTORS.find(
    (entry) => entry.label === "retry.provider.maxRetryDelayMs",
  );
  expect(reserve?.path).toEqual(["retry", "provider", "maxRetryDelayMs"]);
  const overrides = NATIVE_DESCRIPTORS.find(
    (entry) => entry.label === "compaction.modelOverrides",
  );
  expect(overrides?.schema.kind).toBe("map");
  expect(overrides?.description).toContain("independently");
  expect(
    NATIVE_DESCRIPTORS.find((entry) => entry.label === "defaultProjectTrust")
      ?.scopes,
  ).toEqual(["user"]);
});

test("search is case-insensitive, global, and source-labelled", () => {
  const index = new MetadataSearchIndex([...NATIVE_DESCRIPTORS, plugin]);
  expect(index.search("RETRY.PROVIDER").length).toBe(3);
  expect(index.search("specialized")).toEqual([
    { descriptor: plugin, sourceLabel: plugin.sourceLabel },
  ]);
  expect(
    index
      .search("Appearance")
      .every((match) => match.sourceLabel === "Appearance"),
  ).toBe(true);
  expect(index.search("no-such-synthetic-entry")).toEqual([]);
});

test("index excludes values, field metadata, and sensitive descriptor metadata", () => {
  const sensitive: SettingDescriptor = {
    ...plugin,
    id: "sensitive",
    sensitivity: "masked",
    metadataSensitivity: "masked",
    label: "synthetic-secret-label",
  };
  const nested: SettingDescriptor = {
    ...plugin,
    id: "nested",
    schema: {
      kind: "structured",
      preserveUnknown: true,
      fields: {
        authorization: {
          schema: { kind: "text" },
          required: false,
          sensitivity: "masked",
          description: "synthetic-secret-field",
        },
      },
    },
  };
  const index = new MetadataSearchIndex([
    ...NATIVE_DESCRIPTORS,
    sensitive,
    nested,
  ]);
  expect(index.search("synthetic-secret")).toEqual([]);
  expect(index.search("system")).toEqual(
    NATIVE_DESCRIPTORS.filter((entry) =>
      entry.description.toLowerCase().includes("system"),
    ).map((descriptor) => ({
      descriptor,
      sourceLabel: descriptor.sourceLabel,
    })),
  );
  expect(index.search("16384")).toEqual([]);
});

test("replacement removes withdrawn providers and indexes refreshed metadata", () => {
  const index = new MetadataSearchIndex([plugin]);
  index.replace([]);
  expect(index.search("synthetic")).toEqual([]);
  index.replace([{ ...plugin, label: "Refreshed registration" }]);
  expect(index.search("refreshed").length).toBe(1);
});
