import { expect, test } from "bun:test";
import type { JsonValue } from "../src/contracts.ts";
import type { EditorSuggestions } from "../src/editors.ts";
import { ModelChoices } from "../src/model-choices.ts";

function values(
  suggestions: EditorSuggestions,
  path: string[] = [],
  rootValue: JsonValue = {},
  parentValue: JsonValue | null = null,
) {
  return suggestions({ path, rootValue, parentValue, currentValue: "" })?.map(
    (choice) => choice.value,
  );
}
function catalog() {
  return new ModelChoices({
    getAll: () => [
      { provider: "alpha", id: "small", name: "Small model", api: "api-one" },
      { provider: "beta", id: "large", name: "Large model", api: "api-two" },
    ],
    getRegisteredProviderIds: () => ["empty", "alpha"],
  });
}

test("default provider/model choices use local catalogs and provider filtering without constraining custom values", () => {
  const choices = catalog();
  expect(values(choices.native(["defaultProvider"]))).toEqual([
    "alpha",
    "beta",
    "empty",
  ]);
  expect(values(choices.native(["defaultModel"], "alpha"))).toEqual(["small"]);
  expect(values(choices.native(["defaultModel"], "unknown"))).toEqual([]);
  expect(values(choices.native(["defaultModel"]))).toEqual(["small", "large"]);
  const selection = choices.native(
    ["defaultModel"],
    "alpha",
  )({ path: [], rootValue: "", parentValue: null, currentValue: "" });
  expect(selection?.[0]?.label).toContain("Small model");
  expect(selection?.[0]?.description).toBe("alpha/small");
  expect(values(choices.native(["transport"]))).toBeUndefined();
});

test("enabled model items and thinking map keys offer qualified IDs while other fields stay typed", () => {
  const choices = catalog();
  expect(values(choices.native(["enabledModels"]), ["0"])).toEqual([
    "alpha/small",
    "beta/large",
  ]);
  expect(values(choices.native(["modelThinkingLevels"]), ["key"])).toEqual([
    "alpha/small",
    "beta/large",
  ]);
  expect(values(choices.native(["enabledModels"]))).toBeUndefined();
  expect(
    values(choices.native(["modelThinkingLevels"]), ["alpha/small"]),
  ).toBeUndefined();
});

test("provider forms suggest names, model IDs, override keys, API types and provider-filtered fallback IDs", () => {
  const choices = catalog();
  const create = choices.provider(undefined, true);
  const root = { name: "beta", definition: {} };
  expect(values(create, ["name"], root)).toEqual(["alpha", "beta", "empty"]);
  expect(values(create, ["definition", "models", "0", "id"], root)).toEqual([
    "large",
  ]);
  expect(values(create, ["definition", "modelOverrides", "key"], root)).toEqual(
    ["large"],
  );
  expect(values(create, ["definition", "api"], root)).toEqual([
    "api-one",
    "api-two",
  ]);
  const existing = choices.provider("alpha");
  expect(values(existing, ["models", "1", "id"])).toEqual(["small"]);
  expect(
    values(existing, ["compat", "allowedFallbackModels", "0", "provider"]),
  ).toEqual(["alpha", "beta", "empty"]);
  expect(
    values(
      existing,
      ["compat", "allowedFallbackModels", "0", "model"],
      {},
      { provider: "beta" },
    ),
  ).toEqual(["large"]);
  for (const path of [["apiKey"], ["baseUrl"], ["name"], ["headers", "key"]])
    expect(values(existing, path)).toBeUndefined();
});

test("newly saved model metadata enters choices without a runtime reload and removed drafts do not linger", () => {
  const choices = catalog();
  choices.setConfigured({
    providers: {
      custom: {
        api: "new-api",
        models: [{ id: "new-model", name: "New model" }],
      },
    },
  });
  expect(values(choices.native(["defaultProvider"]))).toContain("custom");
  expect(values(choices.native(["defaultModel"], "custom"))).toEqual([
    "new-model",
  ]);
  expect(values(choices.provider("custom"), ["api"])).toContain("new-api");
  choices.setConfigured(undefined);
  expect(values(choices.native(["defaultProvider"]))).not.toContain("custom");
  expect(values(choices.native(["defaultModel"], "custom"))).toEqual([]);
});

test("metadata projection never touches secrets, refresh, availability/auth APIs or unsafe identifiers", () => {
  const source = {
    getAll: () => [
      { provider: "alpha", id: "small", name: "Bad\x1bname", api: "api-one" },
    ],
    getRegisteredProviderIds: () => [
      "http://secret@host",
      "private\x1bname",
      "registered",
    ],
    getAvailable: () => {
      throw new Error("Must not check authentication");
    },
    refresh: () => {
      throw new Error("Must not reload runtime");
    },
    getApiKey: () => {
      throw new Error("Must not resolve credentials");
    },
  };
  const choices = new ModelChoices(source);
  const definition: Record<string, JsonValue> = { models: [{ id: "new" }] };
  Object.defineProperty(definition, "apiKey", {
    enumerable: true,
    get: () => {
      throw new Error("Must not inspect secrets");
    },
  });
  Object.defineProperty(definition, "headers", {
    enumerable: true,
    get: () => {
      throw new Error("Must not inspect headers");
    },
  });
  choices.setConfigured({ providers: { custom: definition } });
  expect(values(choices.native(["defaultProvider"]))).toEqual([
    "alpha",
    "custom",
    "registered",
  ]);
  expect(
    JSON.stringify(
      choices.native(
        ["defaultModel"],
        "alpha",
      )({ path: [], rootValue: "", parentValue: null, currentValue: "" }),
    ),
  ).not.toContain("Bad");
});

test("unavailable metadata leaves empty pickers with manual editing available", () => {
  const choices = new ModelChoices({
    getAll: () => {
      throw new Error("secret diagnostic");
    },
  });
  expect(values(choices.native(["defaultProvider"]))).toEqual([]);
  expect(values(choices.native(["defaultModel"]))).toEqual([]);
});
