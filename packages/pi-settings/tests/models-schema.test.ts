import { describe, expect, test } from "bun:test";
import type { JsonValue, ValueSchema } from "../src/contracts.ts";
import { descriptorCoverage, missingCoverage } from "../src/coverage.ts";
import {
  MODEL_COMPAT_SCHEMA,
  MODEL_OVERRIDE_SCHEMA,
  MODEL_SCHEMA,
  MODELS_DESCRIPTORS,
  MODELS_SCHEMA,
  PROVIDER_SCHEMA,
} from "../src/models-schema.ts";
import { validateModelsConfiguration } from "../src/models-backend.ts";
import { validateValue } from "../src/validation.ts";
import fixture from "./fixtures/pi-0.99.1-coverage.json";

/** Exercise every declared field, even when absent in ordinary minimal configurations. */
function sample(schema: ValueSchema): JsonValue {
  switch (schema.kind) {
    case "json":
      return { arbitrary: [null, true, 2, "literal"] };
    case "boolean":
      return true;
    case "text":
      return "sample";
    case "number":
      return (
        schema.minimum ??
        (schema.exclusiveMinimum === undefined
          ? -0.5
          : schema.exclusiveMinimum + 0.5)
      );
    case "choice":
      return schema.values[0] as JsonValue;
    case "list":
      return [sample(schema.item)];
    case "map":
      return { sample: sample(schema.value) };
    case "union":
      return sample(schema.variants[0] as ValueSchema);
    case "structured":
      return Object.fromEntries(
        Object.entries(schema.fields).map(([key, field]) => [
          key,
          sample(field.schema),
        ]),
      );
  }
}
function branches(
  schema: ValueSchema,
  path = "root",
): { path: string; schema: ValueSchema }[] {
  const result = [{ path, schema }];
  if (schema.kind === "structured")
    for (const [name, field] of Object.entries(schema.fields))
      result.push(...branches(field.schema, `${path}.${name}`));
  if (schema.kind === "map")
    result.push(...branches(schema.value, `${path}.*`));
  if (schema.kind === "list")
    result.push(...branches(schema.item, `${path}[]`));
  if (schema.kind === "union")
    for (const [index, variant] of schema.variants.entries())
      result.push(...branches(variant, `${path}|${index}`));
  return result;
}

describe("models schema baseline", () => {
  test("descriptor coverage includes every reviewed Pi 0.99.1 model field", () => {
    expect(
      missingCoverage(fixture.models, descriptorCoverage(MODELS_DESCRIPTORS)),
    ).toEqual([]);
    expect(
      MODELS_DESCRIPTORS.every(
        (entry) =>
          entry.scopes.join() === "user" && entry.activation === "reload",
      ),
    ).toBe(true);
  });
  test("minimal requiredness and permissive metadata match baseline", () => {
    for (const value of [
      { providers: {} },
      { providers: { p: {} } },
      {
        providers: { p: { models: [{ id: "m" }], modelOverrides: { m: {} } } },
      },
    ])
      expect(validateModelsConfiguration(value).valid).toBe(true);
    for (const value of [
      {},
      { providers: [] },
      { providers: { p: { models: [{}] } } },
    ])
      expect(validateModelsConfiguration(value).valid).toBe(false);
    expect(
      validateValue(MODEL_SCHEMA, {
        id: "m",
        api: "future-api",
        baseUrl: "not-a-probed-url",
        input: [],
        contextWindow: -0.5,
        maxTokens: 0,
      }).valid,
    ).toBe(true);
    expect(
      validateValue(PROVIDER_SCHEMA, {
        apiKey: "!do-not-execute",
        headers: { Authorization: "ENV_NAME" },
      }).valid,
    ).toBe(true);
    expect(
      validateValue(MODEL_SCHEMA, { id: "m", cost: { input: 1 } }).valid,
    ).toBe(false);
    expect(
      validateValue(MODEL_OVERRIDE_SCHEMA, { cost: { input: 1 } }).valid,
    ).toBe(true);
    expect(validateValue(MODEL_SCHEMA, { id: "m", name: "" }).valid).toBe(
      false,
    );
    expect(validateValue(PROVIDER_SCHEMA, { oauth: "other" }).valid).toBe(
      false,
    );
    expect(
      validateValue(MODEL_SCHEMA, { id: "m", input: ["audio"] }).valid,
    ).toBe(false);
  });
  test("complete sample and each nested schema branch accept their valid sample", () => {
    for (const { path, schema } of branches(MODELS_SCHEMA))
      expect(validateValue(schema, sample(schema)).valid, path).toBe(true);
    expect(validateModelsConfiguration(sample(MODELS_SCHEMA)).valid).toBe(true);
  });
  test("all declared known fields reject invalid types, including every compat branch", () => {
    for (const { path, schema } of branches(MODELS_SCHEMA)) {
      if (schema.kind === "json") continue;
      const bad: JsonValue =
        schema.kind === "structured" || schema.kind === "map" ? [] : {};
      // An empty object is valid for a union with an optional structured branch.
      if (schema.kind === "union") {
        expect(validateValue(schema, []).valid, path).toBe(false);
      } else expect(validateValue(schema, bad).valid, path).toBe(false);
      if (schema.kind === "structured") {
        for (const [name, field] of Object.entries(schema.fields)) {
          if (field.schema.kind === "json") continue;
          const value = sample(schema) as Record<string, JsonValue>;
          value[name] = [];
          if (field.schema.kind === "list") value[name] = {};
          expect(validateValue(schema, value).valid, `${path}.${name}`).toBe(
            false,
          );
        }
      }
    }
  });
  test("every declared required field and constrained scalar enforces its baseline rule", () => {
    for (const { path, schema } of branches(MODELS_SCHEMA)) {
      if (schema.kind === "structured") {
        for (const [name, field] of Object.entries(schema.fields)) {
          const value = sample(schema) as Record<string, JsonValue>;
          delete value[name];
          expect(
            validateValue(schema, value).valid,
            `${path}.${name} requiredness`,
          ).toBe(!field.required);
        }
      }
      if (schema.kind === "text") {
        expect(validateValue(schema, "").valid, path).toBe(!schema.minLength);
      }
      if (schema.kind === "choice") {
        for (const value of schema.values)
          expect(validateValue(schema, value).valid, path).toBe(true);
        expect(validateValue(schema, "not-a-baseline-choice").valid, path).toBe(
          false,
        );
      }
    }
  });
  test("unknown future fields remain valid at every structured node", () => {
    for (const { path, schema } of branches(MODELS_SCHEMA)) {
      if (schema.kind !== "structured") continue;
      const value = sample(schema) as Record<string, JsonValue>;
      value.futureField = { nested: [null, "future"] };
      expect(validateValue(schema, value).valid, path).toBe(true);
    }
  });
  test("nonfinite numbers and non-JSON sampling parameters fail safely", () => {
    for (const value of [NaN, Infinity, -Infinity])
      expect(
        validateModelsConfiguration({
          providers: { p: { models: [{ id: "m", contextWindow: value }] } },
        }).valid,
      ).toBe(false);
    expect(
      validateModelsConfiguration({
        providers: {
          p: { models: [{ id: "m", samplingParams: { unknown: undefined } }] },
        },
      } as unknown as JsonValue).valid,
    ).toBe(false);
  });
});

const rates = { input: -1, output: 0, cacheRead: 0.5, cacheWrite: 2 };
describe("complete compat, routing and constraints", () => {
  test("every thinking and affinity encoding accepted; arbitrary API names are not enumerated", () => {
    for (const thinkingFormat of [
      "openai",
      "openrouter",
      "together",
      "baseten",
      "deepseek",
      "zai",
      "qwen",
      "chat-template",
      "qwen-chat-template",
      "string-thinking",
      "ant-ling",
    ])
      expect(validateValue(MODEL_COMPAT_SCHEMA, { thinkingFormat }).valid).toBe(
        true,
      );
    for (const sessionAffinityFormat of [
      "openai",
      "openai-nosession",
      "openrouter",
    ])
      expect(
        validateValue(MODEL_COMPAT_SCHEMA, { sessionAffinityFormat }).valid,
      ).toBe(true);
    for (const maxTokensField of ["max_completion_tokens", "max_tokens"])
      expect(validateValue(MODEL_COMPAT_SCHEMA, { maxTokensField }).valid).toBe(
        true,
      );
    expect(
      validateValue(MODEL_COMPAT_SCHEMA, { thinkingFormat: "unknown" }).valid,
    ).toBe(false);
  });
  test("chat-template scalars and exact variable union, both template maps", () => {
    for (const key of ["chatTemplateKwargs", "chatTemplateArgs"]) {
      for (const value of [
        "literal",
        0,
        true,
        null,
        { $var: "thinking.enabled" },
        { $var: "thinking.effort", omitWhenOff: false },
      ])
        expect(
          validateValue(MODEL_COMPAT_SCHEMA, { [key]: { parameter: value } })
            .valid,
        ).toBe(true);
      for (const value of [
        {},
        { $var: "other" },
        { $var: "thinking.enabled", omitWhenOff: 1 },
        [1],
      ])
        expect(
          validateValue(MODEL_COMPAT_SCHEMA, { [key]: { parameter: value } })
            .valid,
        ).toBe(false);
    }
  });
  test("routing scalar/object/null unions and cost strings", () => {
    for (const routing of [
      {
        sort: "price",
        preferred_min_throughput: 1,
        preferred_max_latency: 0.5,
      },
      {
        sort: {},
        max_price: {
          prompt: "0.1",
          completion: 2,
          image: "auto",
          audio: 0,
          request: "1",
        },
        preferred_min_throughput: { p50: 1, p75: 2, p90: 3, p99: 4 },
      },
      { sort: { by: "latency", partition: null }, preferred_max_latency: {} },
      {
        sort: { partition: "none" },
        data_collection: "allow",
        only: [],
        order: ["provider"],
        ignore: [],
        quantizations: ["fp16"],
        allow_fallbacks: false,
        zdr: true,
        enforce_distillable_text: false,
        require_parameters: true,
      },
    ])
      expect(
        validateValue(MODEL_COMPAT_SCHEMA, { openRouterRouting: routing })
          .valid,
      ).toBe(true);
    for (const routing of [
      { sort: null },
      { sort: { partition: 2 } },
      { preferred_min_throughput: null },
      { preferred_max_latency: { p99: "bad" } },
      { max_price: { prompt: true } },
      { data_collection: "unknown" },
    ])
      expect(
        validateValue(MODEL_COMPAT_SCHEMA, { openRouterRouting: routing })
          .valid,
      ).toBe(false);
  });
  test("cost tiers require all rates and thresholds; override rates alone are optional", () => {
    expect(
      validateValue(MODEL_SCHEMA, {
        id: "m",
        cost: { ...rates, tiers: [{ ...rates, inputTokensAbove: 1 }] },
      }).valid,
    ).toBe(true);
    for (const schema of [MODEL_SCHEMA, MODEL_OVERRIDE_SCHEMA]) {
      expect(
        validateValue(schema, {
          id: "m",
          cost: { ...rates, tiers: [{ inputTokensAbove: 1 }] },
        }).valid,
      ).toBe(false);
      expect(
        validateValue(schema, { id: "m", cost: { ...rates, tiers: [rates] } })
          .valid,
      ).toBe(false);
    }
  });
  test("prompt cache is strictly positive without invented integer constraint", () => {
    for (const key of ["short", "long"]) {
      for (const value of [0.01, 1, 1000])
        expect(
          validateValue(MODEL_SCHEMA, {
            id: "m",
            promptCache: { [key]: value },
          }).valid,
        ).toBe(true);
      for (const value of [0, -1, "1", null])
        expect(
          validateValue(MODEL_SCHEMA, {
            id: "m",
            promptCache: { [key]: value },
          }).valid,
        ).toBe(false);
    }
  });
  test("every input limit is positive integer and JPEG quality has upper bound", () => {
    const paths = [
      ["maxRequestBytes"],
      ["images", "maxPerMessage"],
      ["images", "maxPerRequest"],
      ...["maxWidth", "maxHeight", "maxBytes", "jpegQuality"].map((key) => [
        "images",
        "resize",
        key,
      ]),
    ];
    for (const path of paths) {
      for (const value of [1, 100, 0, -1, 0.5, "1"]) {
        const limits = path
          .toReversed()
          .reduce<JsonValue>((value, key) => ({ [key]: value }), value);
        expect(
          validateValue(MODEL_SCHEMA, { id: "m", inputLimits: limits }).valid,
          path.join("."),
        ).toBe(value === 1 || value === 100);
      }
    }
    expect(
      validateValue(MODEL_SCHEMA, {
        id: "m",
        inputLimits: { images: { resize: { jpegQuality: 101 } } },
      }).valid,
    ).toBe(false);
  });
  test("Anthropic fallback list accepts zero to three, requires provider/model/cost", () => {
    const fallback = { provider: "p", model: "m", cost: rates };
    for (const length of [0, 1, 2, 3, 4])
      expect(
        validateValue(MODEL_COMPAT_SCHEMA, {
          allowedFallbackModels: Array(length).fill(fallback),
        }).valid,
      ).toBe(length <= 3);
    for (const fallback of [
      { provider: "", model: "m", cost: rates },
      { provider: "p", cost: rates },
      { provider: "p", model: "m", cost: {} },
    ])
      expect(
        validateValue(MODEL_COMPAT_SCHEMA, {
          allowedFallbackModels: [fallback],
        }).valid,
      ).toBe(false);
  });
});
