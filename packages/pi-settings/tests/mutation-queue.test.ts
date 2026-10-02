import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  enqueueMutation,
  withConfigurationLock,
} from "../src/mutation-queue.ts";

async function withTemporaryPath(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-lock-"));
  try {
    await run(join(directory, "settings.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("same-path mutations serialize and a rejected mutation does not poison the queue", async () => {
  const steps: string[] = [];
  let unblock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const first = enqueueMutation("synthetic/settings.json", async () => {
    steps.push("first start");
    await gate;
    steps.push("first end");
  });
  const second = enqueueMutation("synthetic/./settings.json", async () => {
    steps.push("second");
  });
  await Promise.resolve();
  expect(steps).toEqual(["first start"]);
  unblock?.();
  await Promise.all([first, second]);
  expect(steps).toEqual(["first start", "first end", "second"]);
  await expect(
    enqueueMutation("synthetic/settings.json", async () => {
      throw new Error("synthetic failure");
    }),
  ).rejects.toThrow("synthetic failure");
  expect(
    await enqueueMutation("synthetic/settings.json", async () => "recovered"),
  ).toBe("recovered");
});

test("different paths can mutate independently", async () => {
  let unblock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const first = enqueueMutation("synthetic/first.json", async () => gate);
  expect(
    await enqueueMutation("synthetic/second.json", async () => "second"),
  ).toBe("second");
  unblock?.();
  await first;
});

test("locks contend with the baseline host convention and always release", async () => {
  await withTemporaryPath(async (path) => {
    await writeFile(path, "{}");
    const release = lockfile.lockSync(path, { realpath: false });
    let called = false;
    try {
      await expect(
        withConfigurationLock(path, async () => {
          called = true;
        }),
      ).rejects.toThrow("locked or unavailable");
      expect(called).toBe(false);
    } finally {
      release();
    }
    expect(
      await withConfigurationLock(path, async (guard) => {
        guard.assertHeld();
        return "saved";
      }),
    ).toBe("saved");
    expect(await lockfile.check(path, { realpath: false })).toBe(false);
    await expect(
      withConfigurationLock(path, async () => {
        throw new Error("synthetic-secret");
      }),
    ).rejects.toThrow("mutation failed");
    expect(await lockfile.check(path, { realpath: false })).toBe(false);
  });
});

test("a missing target can be locked without creating configuration", async () => {
  await withTemporaryPath(async (path) => {
    await withConfigurationLock(path, async (guard) => {
      guard.assertHeld();
      expect(await Bun.file(path).exists()).toBe(false);
    });
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await lockfile.check(path, { realpath: false })).toBe(false);
  });
});
