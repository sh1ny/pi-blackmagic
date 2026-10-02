import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { createLockFilesystem } from "./lock-filesystem.ts";

const lockingFilesystem = createLockFilesystem();
const queues = new Map<string, Promise<void>>();

/** Normalize spelling so concurrent callers share one in-process queue. */
function queueKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export async function enqueueMutation<T>(
  path: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const key = queueKey(path);
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(mutation);
  const tail = current.then(
    () => {},
    () => {},
  );
  queues.set(key, tail);
  try {
    return await current;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

export interface LockGuard {
  assertHeld(): void;
}

/** Matches baseline settings.json's path.lock convention, even for missing target files. */
export async function withConfigurationLock<T>(
  path: string,
  mutation: (guard: LockGuard) => Promise<T>,
): Promise<T> {
  let compromised = false;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, {
      fs: lockingFilesystem,
      realpath: false,
      retries: {
        retries: 9,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20,
        randomize: false,
      },
      onCompromised: () => {
        compromised = true;
      },
    });
  } catch {
    throw new Error(
      "Configuration mutation failed; the file may be locked or unavailable.",
    );
  }
  const guard: LockGuard = {
    assertHeld() {
      if (compromised)
        throw new Error(
          "Configuration lock was lost; refresh before retrying.",
        );
    },
  };
  let outcome: { ok: true; value: T } | { ok: false };
  try {
    guard.assertHeld();
    outcome = { ok: true, value: await mutation(guard) };
  } catch {
    outcome = { ok: false };
  }
  if (!compromised) {
    try {
      await release();
    } catch {
      throw new Error(
        "Configuration lock cleanup failed; refresh before retrying.",
      );
    }
  }
  if (!outcome.ok || compromised)
    throw new Error(
      "Configuration mutation failed; the file may be locked or unavailable.",
    );
  return outcome.value;
}
