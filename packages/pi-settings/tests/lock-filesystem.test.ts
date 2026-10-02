import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  createLockFilesystem,
  type LockFilesystem,
} from "../src/lock-filesystem.ts";
import { withConfigurationLock } from "../src/mutation-queue.ts";

// Test-only access to the pinned dependency's exact cache probe; production uses its public fs option.
const require = createRequire(import.meta.url);
const { probe } = require("proper-lockfile/lib/mtime-precision") as {
  probe(
    path: string,
    filesystem: LockFilesystem,
    callback: (error: NodeJS.ErrnoException | null) => void,
  ): void;
};

test("local lock filesystem isolates immutable precision caching from a proxied module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-proxy-lock-"));
  const target = createLockFilesystem();
  const proxied = new Proxy(target, {
    get(object, property, receiver) {
      const descriptor = Object.getOwnPropertyDescriptor(object, property);
      if (
        typeof property === "symbol" &&
        descriptor &&
        descriptor.configurable === false &&
        descriptor.writable === false
      )
        return descriptor.value === "ms" ? "s" : "ms";
      return Reflect.get(object, property, receiver);
    },
  });
  try {
    await new Promise<void>((resolve, reject) =>
      probe(directory, proxied, (error) => (error ? reject(error) : resolve())),
    );
    expect(() => probe(directory, proxied, () => {})).toThrow("Proxy");
    const local = createLockFilesystem(proxied);
    expect(Object.getPrototypeOf(local)).toBe(Object.prototype);
    const file = join(directory, "settings.json");
    for (let index = 0; index < 4; index++) {
      const release = await lockfile.lock(file, { realpath: false, fs: local });
      expect(await lockfile.check(file, { realpath: false, fs: local })).toBe(
        true,
      );
      await release();
      expect(await Bun.file(file).exists()).toBe(false);
      expect(await lockfile.check(file, { realpath: false, fs: local })).toBe(
        false,
      );
    }
    expect(Object.getOwnPropertySymbols(local).length).toBeGreaterThan(0);
    const hostRelease = lockfile.lockSync(file, { realpath: false });
    try {
      await expect(withConfigurationLock(file, async () => {})).rejects.toThrow(
        "locked or unavailable",
      );
    } finally {
      hostRelease();
    }
    for (let index = 0; index < 4; index++)
      expect(
        await withConfigurationLock(file, async (guard) => {
          guard.assertHeld();
          return "saved";
        }),
      ).toBe("saved");
    expect(await lockfile.check(file, { realpath: false })).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
