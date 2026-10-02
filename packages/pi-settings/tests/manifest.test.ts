import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function isAllowlisted(path: string): boolean {
  const packagePath = relative(root, path).replaceAll("\\", "/");
  return manifest.files.some(
    (entry: string) =>
      packagePath === entry || packagePath.startsWith(`${entry}/`),
  );
}

test("the standalone manifest declares an explicit raw TypeScript entrypoint", () => {
  expect(manifest.name).toBe("@pi-blackmagic/pi-settings");
  expect(manifest.version).toBe("0.1.0");
  expect(manifest.type).toBe("module");
  expect(manifest.exports).toEqual({
    ".": "./src/index.ts",
    "./registration": "./src/registration.ts",
  });
  expect(manifest.pi).toEqual({ extensions: ["./src/index.ts"] });
  expect(manifest.peerDependencies).toEqual({
    "@earendil-works/pi-coding-agent": "~0.99.1",
    "@earendil-works/pi-tui": "~0.99.1",
  });
  expect(manifest.dependencies).toEqual({
    "proper-lockfile": "4.1.2",
    "hosted-git-info": "9.0.3",
  });
});

test("every resource and export exists and is included in the publish allowlist", () => {
  expect(manifest.files).toEqual(["src", "README.md", "docs"]);
  const resources = [
    ...manifest.pi.extensions,
    ...Object.values(manifest.exports),
  ] as string[];

  for (const resource of resources) {
    expect(resource.endsWith(".ts")).toBe(true);
    const path = join(root, resource);
    expect(existsSync(path)).toBe(true);
    expect(isAllowlisted(path)).toBe(true);
  }
  for (const entry of manifest.files) {
    expect(existsSync(join(root, entry))).toBe(true);
  }
  for (const path of filesUnder(join(root, "tests"))) {
    expect(isAllowlisted(path)).toBe(false);
  }
  for (const path of filesUnder(join(root, "src"))) {
    expect(path.endsWith(".test.ts")).toBe(false);
    expect(path.endsWith(".spec.ts")).toBe(false);
  }
});

test("source imports distinguish built-ins, runtime dependencies, and host peers", () => {
  const imports = new Set<string>();
  for (const path of filesUnder(join(root, "src"))) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (
        specifier &&
        !specifier.startsWith(".") &&
        !specifier.startsWith("node:")
      ) {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (packageName) imports.add(packageName);
      }
    }
  }

  expect([...imports].sort()).toEqual(
    [
      ...Object.keys(manifest.peerDependencies),
      ...Object.keys(manifest.dependencies),
    ].sort(),
  );
  expect(imports.has("pi-blackmagic")).toBe(false);
});
