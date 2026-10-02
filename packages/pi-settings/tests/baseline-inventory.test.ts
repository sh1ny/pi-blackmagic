import { expect, test } from "bun:test";
import { nativeInventory, schemaInventory } from "./baseline-inventory.ts";

test("TypeScript 7 virtual parsing supports interface inheritance, unions, maps, and object arrays", () => {
  expect(
    nativeInventory(`
    interface Base { enabled?: boolean; }
    interface Entry extends Base { name: string; }
    type Source = string | { source: string; };
    interface Settings { entries?: Entry[]; sources?: Source[]; byName?: Record<string, Entry>; }
  `),
  ).toEqual([
    "byName",
    "byName.*",
    "byName.*.enabled",
    "byName.*.name",
    "entries",
    "entries[]",
    "entries[].enabled",
    "entries[].name",
    "sources",
    "sources[]",
    "sources[].source",
  ]);
});

test("TypeScript 7 inspects schema syntax without executing it", () => {
  expect(
    schemaInventory(
      `
    throw new Error("This source must never execute");
    const fields = { count: Type.Number() };
    const Entry = Type.Object({ ...fields, label: Type.Optional(Type.String()) });
    const Root = Type.Object({ entries: Type.Array(Entry), names: Type.Array(Type.String()), byName: Type.Record(Type.String(), Entry) });
  `,
      "Root",
    ),
  ).toEqual([
    "byName",
    "byName.*",
    "byName.*.count",
    "byName.*.label",
    "entries",
    "entries[]",
    "entries[].count",
    "entries[].label",
    "names",
  ]);
});

test("malformed syntax rejects and later virtual parsing still works", () => {
  expect(() => nativeInventory("interface Settings { invalid: ; }")).toThrow(
    "syntax errors",
  );
  expect(nativeInventory("interface Settings { valid: boolean; }")).toEqual([
    "valid",
  ]);
});
