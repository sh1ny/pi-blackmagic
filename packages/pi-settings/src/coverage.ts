import type { SettingDescriptor, ValueSchema } from "./contracts.ts";

/** Enumerate supported container and leaf paths, including structured dynamic entries. */
export function descriptorCoverage(
  descriptors: readonly SettingDescriptor[],
): string[] {
  const paths = new Set<string>();
  function visit(path: string, schema: ValueSchema): void {
    paths.add(path);
    if (schema.kind === "structured") {
      for (const [name, field] of Object.entries(schema.fields))
        visit(`${path}.${name}`, field.schema);
    } else if (schema.kind === "map") {
      visit(`${path}.*`, schema.value);
    } else if (schema.kind === "list") {
      visit(`${path}[]`, schema.item);
    } else if (schema.kind === "union") {
      for (const variant of schema.variants) visit(path, variant);
    }
  }
  for (const descriptor of descriptors) {
    const path = descriptor.path.join(".");
    const segments = descriptor.path;
    for (let count = 1; count < segments.length; count++)
      paths.add(segments.slice(0, count).join("."));
    visit(path, descriptor.schema);
  }
  return [...paths].sort();
}

export function missingCoverage(
  expected: readonly string[],
  actual: readonly string[],
): string[] {
  const covered = new Set(actual);
  return expected.filter((path) => !covered.has(path)).sort();
}
