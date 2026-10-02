import type { JsonValue } from "./contracts.ts";
import { NATIVE_DEFAULTS } from "./native-catalog.ts";
import { combinedPackages } from "./native-resources.ts";
import type { ResourceBases } from "./native-resources.ts";

function object(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Mirrors baseline manager nested merging; resource loading composition is handled separately. */
function deepMerge(
  user: Record<string, JsonValue>,
  project: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const result = structuredClone(user);
  for (const [key, value] of Object.entries(project)) {
    const base = Object.hasOwn(result, key) ? result[key] : undefined;
    const merged =
      object(base) && object(value)
        ? deepMerge(base, value)
        : structuredClone(value);
    Object.defineProperty(result, key, {
      value: merged,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

export function mergeNativeSettings(
  user: Record<string, JsonValue>,
  project: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const result = deepMerge(user, project);
  if (
    Array.isArray(user.defaultTools) &&
    Array.isArray(project.defaultTools) &&
    project.defaultTools.every(isToolModifier)
  ) {
    result.defaultTools = [...user.defaultTools, ...project.defaultTools];
  }
  for (const key of ["defaultProjectTrust", "httpProxy", "cacheWarming"]) {
    if (Object.hasOwn(user, key))
      result[key] = structuredClone(user[key] as JsonValue);
    else delete result[key];
  }
  return result;
}

function isToolModifier(value: JsonValue): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("+") || value.startsWith("-"))
  );
}

export function resolvedTools(value: JsonValue | undefined): JsonValue {
  if (!Array.isArray(value))
    return structuredClone(NATIVE_DEFAULTS.defaultTools as JsonValue);
  const entries = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  const plain = entries.filter((entry) => !isToolModifier(entry));
  const tools: string[] =
    plain.length > 0 || entries.length === 0
      ? [...plain]
      : [...(NATIVE_DEFAULTS.defaultTools as string[])];
  for (const entry of entries) {
    if (!isToolModifier(entry)) continue;
    const name = entry.slice(1);
    const index = tools.indexOf(name);
    if (entry.startsWith("+") && index === -1 && name) tools.push(name);
    else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
  }
  return tools;
}

/** Preserve the host loader's two-layer resource declarations; do not flatten exclusion syntax. */
export function combinedResources(
  path: string,
  user: Record<string, JsonValue>,
  project: Record<string, JsonValue>,
  bases: ResourceBases,
): JsonValue | undefined {
  if (!["packages", "extensions", "skills", "prompts", "themes"].includes(path))
    return undefined;
  const global = user[path];
  const local = project[path];
  if (path === "packages") return combinedPackages(global, local, bases);
  return [
    ...(Array.isArray(local) ? local : []),
    ...(Array.isArray(global) ? global : []),
  ];
}
