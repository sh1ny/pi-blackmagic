import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const entrypoints = {
  "pi-settings": "packages/pi-settings/src/index.ts",
  suite: "packages/blackmagic/src/index.ts",
} as const;

export function buildPiArgs(
  target: string,
  extraArgs: string[] = [],
): string[] {
  if (!Object.hasOwn(entrypoints, target)) {
    throw new Error(`Unknown extension target: ${target}`);
  }
  const entrypoint = entrypoints[target as keyof typeof entrypoints];
  return [
    "--no-extensions",
    "--extension",
    resolve(root, entrypoint),
    ...extraArgs,
  ];
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    throw new Error("Choose pi-settings or suite.");
  }
  const child = Bun.spawnSync(
    ["pi", ...buildPiArgs(target, process.argv.slice(3))],
    {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(child.exitCode);
}
