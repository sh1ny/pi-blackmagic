import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { buildPiArgs } from "./dev-pi.ts";

describe("isolated Pi launch arguments", () => {
  for (const [target, packageName] of [
    ["pi-settings", "pi-settings"],
    ["suite", "blackmagic"],
  ] as const) {
    test(target, () => {
      const args = buildPiArgs(target, ["--name", "name with spaces"]);
      expect(args.slice(0, 2)).toEqual(["--no-extensions", "--extension"]);
      expect(isAbsolute(args[2] ?? "")).toBe(true);
      expect(args[2]?.replaceAll("\\", "/")).toEndWith(
        `/packages/${packageName}/src/index.ts`,
      );
      expect(args.slice(3)).toEqual(["--name", "name with spaces"]);
      expect(args.filter((arg) => arg === "--extension")).toHaveLength(1);
    });
  }
  test("rejects unknown targets", () => {
    expect(() => buildPiArgs("unknown")).toThrow("Unknown extension target");
    expect(() => buildPiArgs("toString")).toThrow("Unknown extension target");
  });
});
