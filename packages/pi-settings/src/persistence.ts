import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readConfiguration, hasErrorCode } from "./configuration-read.ts";
import type { JsonValue, Revision, ValidationResult } from "./contracts.ts";
import { enqueueMutation, withConfigurationLock } from "./mutation-queue.ts";
import type { ConfigurationPath } from "./paths.ts";

export type EntrySnapshot =
  | { present: false }
  | { present: true; value: JsonValue };
export interface SemanticMutation {
  path: readonly string[];
  expectedRevision: Revision;
  change:
    | { operation: "set"; value: JsonValue }
    | { operation: "remove" }
    | { operation: "rename"; destination: string; value: JsonValue };
}
export type PersistenceResult =
  | { state: "persisted"; entry: EntrySnapshot; revision: Revision }
  | {
      state: "rejected";
      reason: "validation" | "conflict" | "unavailable";
      message: string;
    }
  | { state: "failed"; message: string };

function canonical(
  value: JsonValue,
  orderedObjectPaths: readonly (readonly string[])[],
  path: readonly string[] = [],
): string {
  if (Array.isArray(value))
    return `[${value.map((item, index) => canonical(item, orderedObjectPaths, [...path, String(index)])).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (
      !orderedObjectPaths.some(
        (candidate) =>
          candidate.length === path.length &&
          candidate.every((part, index) => part === path[index]),
      )
    )
      keys.sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue, orderedObjectPaths, [...path, key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Most object key ordering is cosmetic; callers declare maps whose iteration order has host semantics. */
export function entryRevision(
  entry: EntrySnapshot,
  orderedObjectPaths: readonly (readonly string[])[] = [],
): Revision {
  return createHash("sha256")
    .update(
      entry.present
        ? `present:${canonical(entry.value, orderedObjectPaths)}`
        : "absent",
    )
    .digest("hex");
}

export function readEntry(
  root: Record<string, JsonValue>,
  path: readonly string[],
): EntrySnapshot {
  let current: JsonValue = root;
  for (const key of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    )
      return { present: false };
    current = current[key] as JsonValue;
  }
  return { present: true, value: structuredClone(current) };
}

function patch(
  root: Record<string, JsonValue>,
  mutation: SemanticMutation,
): void {
  let parent = root;
  for (const key of mutation.path.slice(0, -1)) {
    const child = Object.hasOwn(parent, key) ? parent[key] : undefined;
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      if (child !== undefined) throw new Error("Parent is not an object.");
      Object.defineProperty(parent, key, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    parent = parent[key] as Record<string, JsonValue>;
  }
  const key = mutation.path.at(-1);
  if (key === undefined) throw new Error("A nonempty entry path is required.");
  const { change } = mutation;
  if (change.operation === "remove") delete parent[key];
  else {
    const destination =
      change.operation === "rename" ? change.destination : key;
    if (
      change.operation === "rename" &&
      destination !== key &&
      Object.hasOwn(parent, destination)
    )
      throw new Error("Destination exists.");
    if (change.operation === "rename") delete parent[key];
    Object.defineProperty(parent, destination, {
      value: structuredClone(change.value),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

export interface PersistenceOptions {
  /** Re-resolve trust immediately before reading/mutating, not only when the editor opens. */
  location: () => ConfigurationPath;
  mutation: SemanticMutation;
  validateEntry(value: JsonValue): ValidationResult;
  validateConfiguration(value: Record<string, JsonValue>): ValidationResult;
  signal?: AbortSignal;
  allowComments?: boolean;
  /** Must match read-side revisions, including subsystem-specific order-sensitive maps. */
  revisionOf?: (entry: EntrySnapshot) => Revision;
  /** Filesystem seam for replacement-failure testing. Never use a truncating fallback. */
  replace?: (temporary: string, target: string) => Promise<void>;
}

export async function persistEntry(
  options: PersistenceOptions,
): Promise<PersistenceResult> {
  const { mutation } = options;
  const revisionOf = options.revisionOf ?? entryRevision;
  if (
    mutation.path.length === 0 ||
    mutation.path.some((part) => part.length === 0)
  )
    return {
      state: "rejected",
      reason: "validation",
      message: "An entry path is required.",
    };
  if (
    mutation.change.operation !== "remove" &&
    !options.validateEntry(mutation.change.value).valid
  )
    return {
      state: "rejected",
      reason: "validation",
      message: "Entry validation failed.",
    };
  const initial = options.location();
  if (initial.state === "unavailable")
    return {
      state: "rejected",
      reason: "unavailable",
      message: initial.reason,
    };
  return enqueueMutation(initial.path, async () => {
    const location = options.location();
    if (
      location.state === "unavailable" ||
      location.path !== initial.path ||
      options.signal?.aborted
    )
      return {
        state: "rejected",
        reason: "unavailable",
        message: "Configuration access is no longer available.",
      };
    try {
      // Creating a directory is allowed only for a completed, locally validated write.
      await mkdir(dirname(location.path), { recursive: true });
      return await withConfigurationLock(
        location.path,
        async (guard): Promise<PersistenceResult> => {
          if (
            options.location().state !== "available" ||
            options.signal?.aborted
          )
            return {
              state: "rejected",
              reason: "unavailable",
              message: "Configuration access is no longer available.",
            };
          const current = await readConfiguration(
            location,
            options.allowComments,
          );
          if (current.state !== "available")
            return {
              state: "failed",
              message:
                current.state === "error"
                  ? current.message
                  : "Configuration is unavailable.",
            };
          const baseline = readEntry(current.value, mutation.path);
          if (revisionOf(baseline) !== mutation.expectedRevision)
            return {
              state: "rejected",
              reason: "conflict",
              message: "This entry changed externally; refresh and re-edit.",
            };
          const targetPath =
            mutation.change.operation === "rename"
              ? [...mutation.path.slice(0, -1), mutation.change.destination]
              : mutation.path;
          if (
            mutation.change.operation === "rename" &&
            mutation.change.destination !== mutation.path.at(-1) &&
            readEntry(current.value, targetPath).present
          )
            return {
              state: "rejected",
              reason: "conflict",
              message: "The destination entry already exists.",
            };
          const next = structuredClone(current.value);
          try {
            patch(next, mutation);
          } catch {
            return {
              state: "rejected",
              reason: "validation",
              message: "The entry cannot be changed at this path.",
            };
          }
          if (!options.validateConfiguration(next).valid)
            return {
              state: "rejected",
              reason: "validation",
              message: "Resulting configuration validation failed.",
            };
          const temporary = join(
            dirname(location.path),
            `.pi-settings-${randomUUID()}.tmp`,
          );
          try {
            let mode = 0o600;
            try {
              mode = (await stat(location.path)).mode & 0o777;
            } catch (error) {
              if (!hasErrorCode(error, "ENOENT")) throw error;
            }
            const handle = await open(temporary, "wx", mode);
            try {
              await handle.writeFile(
                `${JSON.stringify(next, null, 2)}\n`,
                "utf8",
              );
              await handle.sync();
            } finally {
              await handle.close();
            }
            await chmod(temporary, mode);
            guard.assertHeld();
            if (
              options.signal?.aborted ||
              options.location().state !== "available"
            )
              return {
                state: "rejected",
                reason: "unavailable",
                message: "Configuration access is no longer available.",
              };
            await (options.replace ?? rename)(temporary, location.path);
            const entry = readEntry(next, targetPath);
            return {
              state: "persisted",
              entry,
              revision: revisionOf(entry),
            };
          } catch {
            return {
              state: "failed",
              message:
                "Configuration replacement failed; refresh before retrying.",
            };
          } finally {
            await rm(temporary, { force: true });
          }
        },
      );
    } catch {
      return {
        state: "failed",
        message: "Configuration mutation failed; refresh before retrying.",
      };
    }
  });
}
