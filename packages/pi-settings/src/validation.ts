import type { JsonValue, ValidationResult, ValueSchema } from "./contracts.ts";

/** Local, credential-blind validation. Errors never interpolate submitted values. */
export function validateValue(
  schema: ValueSchema,
  value: JsonValue,
): ValidationResult {
  const valid = accepts(schema, value);
  return valid
    ? { valid: true }
    : { valid: false, message: "Value does not match the setting schema." };
}

function accepts(schema: ValueSchema, value: JsonValue): boolean {
  switch (schema.kind) {
    case "json":
      return isJsonValue(value);
    case "boolean":
      return typeof value === "boolean";
    case "text":
      return (
        typeof value === "string" &&
        (schema.minLength === undefined || value.length >= schema.minLength) &&
        (schema.maxLength === undefined || value.length <= schema.maxLength)
      );
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!schema.integer || Number.isInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum) &&
        (schema.exclusiveMinimum === undefined ||
          value > schema.exclusiveMinimum)
      );
    case "choice":
      return schema.values.some((candidate) => candidate === value);
    case "union":
      return schema.variants.some((variant) => accepts(variant, value));
    case "list":
      return (
        Array.isArray(value) &&
        (schema.minItems === undefined || value.length >= schema.minItems) &&
        (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        value.every((item) => accepts(schema.item, item))
      );
    case "map":
      return (
        isObject(value) &&
        Object.values(value).every((item) => accepts(schema.value, item))
      );
    case "structured":
      if (!isObject(value)) return false;
      for (const [key, field] of Object.entries(schema.fields)) {
        if (!Object.hasOwn(value, key)) {
          if (field.required) return false;
        } else if (!accepts(field.schema, value[key] as JsonValue))
          return false;
      }
      return (
        schema.preserveUnknown ||
        Object.keys(value).every((key) => Object.hasOwn(schema.fields, key))
      );
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(isJsonValue)
  );
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
