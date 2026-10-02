import { createHash, randomUUID } from "node:crypto";
import type { JsonValue, SettingDescriptor, ValueSchema } from "./contracts.ts";
import { validateValue } from "./validation.ts";

export const MASKED_VALUE = Object.freeze({ $piSettingsMasked: true });
const references = new Map<
  string,
  { path: readonly string[]; fingerprint: string }
>();
const credentialField =
  /^(apiKey|api_key|password|secret|clientSecret|accessToken|refreshToken|authorization|httpProxy)$/i;

function object(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isMasked(value: JsonValue): boolean {
  return (
    object(value) &&
    value.$piSettingsMasked === true &&
    Object.keys(value).every(
      (key) => key === "$piSettingsMasked" || key === "$token",
    ) &&
    (value.$token === undefined || typeof value.$token === "string")
  );
}
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function fingerprint(value: JsonValue): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function retain(
  value: JsonValue,
  path: readonly string[],
  track: boolean,
): JsonValue {
  if (!track) return { ...MASKED_VALUE };
  const token = randomUUID();
  references.set(token, { path, fingerprint: fingerprint(value) });
  return { ...MASKED_VALUE, $token: token };
}

/** Cleared by the interaction owner only after pending writes have settled. Stores no raw secrets. */
export function clearMaskedReferences(): void {
  references.clear();
}

function embeddedCredentials(value: string): boolean {
  const candidate = value.startsWith("git:") ? value.slice(4) : value;
  try {
    const url = new URL(candidate);
    return (
      Boolean(url.username || url.password) ||
      [...url.searchParams.keys()].some(
        (key) => credentialField.test(key) || /^(token|key|auth)$/i.test(key),
      )
    );
  } catch {
    return false;
  }
}

/** Safe editor tree. Opaque references retain the right original even after list/map restructuring. */
export function maskValue(
  value: JsonValue,
  descriptor: Pick<SettingDescriptor, "sensitivity" | "schema">,
): JsonValue {
  if (isMasked(value)) return structuredClone(value);
  return descriptor.sensitivity === "masked"
    ? retain(value, [], true)
    : mask(value, descriptor.schema, [], true);
}

function mask(
  value: JsonValue,
  schema: ValueSchema | undefined,
  path: readonly string[],
  track: boolean,
): JsonValue {
  if (isMasked(value))
    return track ? structuredClone(value) : { ...MASKED_VALUE };
  if (schema?.kind === "union") {
    const variant = schema.variants.find(
      (entry) => validateValue(entry, value).valid,
    );
    if (variant) return mask(value, variant, path, track);
  }
  if (typeof value === "string" && embeddedCredentials(value))
    return retain(value, path, track);
  if (Array.isArray(value))
    return value.map((entry, index) =>
      mask(
        entry,
        schema?.kind === "list" ? schema.item : undefined,
        [...path, String(index)],
        track,
      ),
    );
  if (!object(value)) return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    const field =
      schema?.kind === "structured" && Object.hasOwn(schema.fields, key)
        ? schema.fields[key]
        : undefined;
    const childSchema =
      field?.schema ?? (schema?.kind === "map" ? schema.value : undefined);
    const childPath = [...path, key];
    const sensitive =
      credentialField.test(key) ||
      field?.sensitivity === "masked" ||
      (schema?.kind === "structured" && !field);
    const masked = sensitive
      ? retain(child, childPath, track)
      : (key === "headers" || key === "env") && object(child)
        ? Object.fromEntries(
            Object.entries(child).map(([name, entry]) => [
              name,
              retain(entry, [...childPath, name], track),
            ]),
          )
        : mask(child, childSchema, childPath, track);
    Object.defineProperty(result, key, {
      value: masked,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function at(
  root: JsonValue,
  path: readonly string[],
): { present: false } | { present: true; value: JsonValue } {
  let value = root;
  for (const key of path) {
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(key) || !Object.hasOwn(value, key))
        return { present: false };
      value = value[Number(key)] as JsonValue;
    } else if (object(value) && Object.hasOwn(value, key))
      value = value[key] as JsonValue;
    else return { present: false };
  }
  return { present: true, value };
}
function matching(
  root: JsonValue,
  expected: string,
): { present: false } | { present: true; value: JsonValue } {
  if (fingerprint(root) === expected) return { present: true, value: root };
  if (Array.isArray(root) || object(root)) {
    for (const child of Object.values(root)) {
      const found = matching(child, expected);
      if (found.present) return found;
    }
  }
  return { present: false };
}

/** Restore retained nodes from the current original, never from raw values stored in marker metadata. */
export function restoreMasked(
  draft: JsonValue,
  original: JsonValue,
): JsonValue {
  function restore(value: JsonValue, position: readonly string[]): JsonValue {
    if (isMasked(value)) {
      if (object(value) && typeof value.$token === "string") {
        const reference = references.get(value.$token);
        if (!reference)
          throw new Error(
            "Masked retention reference is unavailable; refresh the entry.",
          );
        const direct = at(original, reference.path);
        const found =
          direct.present && fingerprint(direct.value) === reference.fingerprint
            ? direct
            : matching(original, reference.fingerprint);
        if (!found.present)
          throw new Error("A masked field has no original value.");
        return structuredClone(found.value);
      }
      const found = at(original, position);
      if (!found.present)
        throw new Error("A masked field has no original value.");
      return structuredClone(found.value);
    }
    if (Array.isArray(value))
      return value.map((entry, index) =>
        restore(entry, [...position, String(index)]),
      );
    if (!object(value)) return value;
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value))
      Object.defineProperty(result, key, {
        value: restore(child, [...position, key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return result;
  }
  return restore(draft, []);
}

/** Ordinary display never includes opaque retention tokens or secret fingerprints. */
export function safeDisplay(
  value: JsonValue,
  descriptor: Pick<SettingDescriptor, "sensitivity" | "schema">,
): string {
  return JSON.stringify(
    descriptor.sensitivity === "masked"
      ? { ...MASKED_VALUE }
      : mask(value, descriptor.schema, [], false),
  );
}

export function safeDiagnostic(
  _error: unknown,
  operation: "read" | "validation" | "write" | "activation",
): string {
  return `Settings ${operation} failed. Refresh and retry; sensitive diagnostic details are withheld.`;
}
