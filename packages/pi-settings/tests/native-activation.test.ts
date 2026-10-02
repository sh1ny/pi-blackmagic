import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NATIVE_ACTIVATION, activateNative } from "../src/native-activation.ts";
import { NativeBackend } from "../src/native-backend.ts";
import { NATIVE_DESCRIPTORS } from "../src/native-catalog.ts";

test("activation matrix covers every baseline setting and distinguishes reload/restart", async () => {
  expect(Object.keys(NATIVE_ACTIVATION).sort()).toEqual(
    NATIVE_DESCRIPTORS.map((descriptor) => descriptor.id).sort(),
  );
  expect(await activateNative("native.defaultModel", "startup")).toEqual({
    state: "required",
    requirement: "reload",
  });
  expect(await activateNative("native.tuiMode", "fullscreen")).toEqual({
    state: "required",
    requirement: "restart",
  });
  expect(
    await activateNative("native.theme", "synthetic", () => ({
      success: true,
    })),
  ).toEqual({ state: "active" });
  expect(await activateNative("native.theme", "synthetic")).toEqual({
    state: "required",
    requirement: "reload",
  });
});

test("runtime theme failure is saved-but-not-active, never a fictitious disk failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-activation-"));
  try {
    const backend = new NativeBackend({
      context: { cwd: directory, isProjectTrusted: () => false },
      agentDirectory: () => directory,
      applyTheme: () => {
        throw new Error("synthetic-secret-runtime-error");
      },
    });
    const read = await backend.read("native.theme", "user");
    if (read.state !== "available") throw new Error("Missing theme");
    const result = await backend.write({
      descriptorId: "native.theme",
      scope: "user",
      expectedRevision: read.revision,
      operation: "set",
      value: "synthetic",
    });
    expect(result.state).toBe("persisted");
    if (result.state !== "persisted")
      throw new Error("Missing persistence acknowledgement");
    expect(result.activation.state).toBe("failed");
    expect(JSON.stringify(result.activation)).not.toContain("synthetic-secret");
    expect(
      JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
        .theme,
    ).toBe("synthetic");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
