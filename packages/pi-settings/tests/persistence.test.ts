import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryRevision, persistEntry, readEntry } from "../src/persistence.ts";
import type { PersistenceOptions } from "../src/persistence.ts";

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-writer-"));
  try {
    await run(join(directory, "settings.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function options(path: string, value = "new"): PersistenceOptions {
  return {
    location: () => ({ state: "available", scope: "user", path }),
    mutation: {
      path: ["theme"],
      expectedRevision: entryRevision({ present: true, value: "old" }),
      change: { operation: "set", value },
    },
    validateEntry: () => ({ valid: true }),
    validateConfiguration: () => ({ valid: true }),
  };
}

test("semantic patches preserve unrelated external edits, unknown fields, and permissions", async () => {
  await fixture(async (path) => {
    await writeFile(
      path,
      JSON.stringify({
        theme: "old",
        external: "latest",
        future: { nested: true },
        authorization: "synthetic-secret",
      }),
    );
    await chmod(path, 0o600);
    const originalMode = (await stat(path)).mode & 0o777;
    const result = await persistEntry(options(path));
    expect(result.state).toBe("persisted");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      theme: "new",
      external: "latest",
      future: { nested: true },
      authorization: "synthetic-secret",
    });
    expect((await stat(path)).mode & 0o777).toBe(originalMode);
    expect(await readdir(join(path, ".."))).toEqual(["settings.json"]);
  });
});

test("same-entry changes reject rather than overwrite newer data", async () => {
  await fixture(async (path) => {
    await writeFile(path, '{"theme":"external"}');
    const result = await persistEntry(options(path));
    expect(result.state).toBe("rejected");
    expect(await readFile(path, "utf8")).toBe('{"theme":"external"}');
  });
});

test("rename is one coherent patch and destination collisions reject", async () => {
  await fixture(async (path) => {
    await writeFile(
      path,
      '{"servers":{"old":{"command":"synthetic"},"other":{"enabled":false}}}',
    );
    const request = options(path);
    request.mutation = {
      path: ["servers", "old"],
      expectedRevision: entryRevision({
        present: true,
        value: { command: "synthetic" },
      }),
      change: {
        operation: "rename",
        destination: "other",
        value: { command: "renamed" },
      },
    };
    expect((await persistEntry(request)).state).toBe("rejected");
    request.mutation.change = {
      operation: "rename",
      destination: "renamed",
      value: { command: "renamed" },
    };
    expect((await persistEntry(request)).state).toBe("persisted");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      servers: { renamed: { command: "renamed" }, other: { enabled: false } },
    });
  });
});

test("malformed JSON and failed replacement never truncate and clean temporary files", async () => {
  await fixture(async (path) => {
    await writeFile(path, '{"theme": synthetic-secret-malformed');
    const malformed = await persistEntry(options(path));
    expect(malformed.state).toBe("failed");
    expect(JSON.stringify(malformed)).not.toContain("synthetic-secret");
    expect(await readFile(path, "utf8")).toBe(
      '{"theme": synthetic-secret-malformed',
    );
    await writeFile(path, '{"theme":"old"}');
    const failed = await persistEntry({
      ...options(path),
      replace: async () => {
        throw new Error("synthetic-secret-failure");
      },
    });
    expect(failed.state).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain("synthetic-secret");
    expect(await readFile(path, "utf8")).toBe('{"theme":"old"}');
    expect(await readdir(join(path, ".."))).toEqual(["settings.json"]);
  });
});

test("remove override preserves other nested fields, including literal prototype keys", async () => {
  await fixture(async (path) => {
    await writeFile(
      path,
      '{"nested":{"theme":"old","future":true},"__proto__":{"value":"keep"}}',
    );
    const request = options(path);
    request.mutation = {
      path: ["nested", "theme"],
      expectedRevision: entryRevision({ present: true, value: "old" }),
      change: { operation: "remove" },
    };
    expect((await persistEntry(request)).state).toBe("persisted");
    const result = JSON.parse(await readFile(path, "utf8"));
    expect(result.nested).toEqual({ future: true });
    expect(readEntry(result, ["__proto__", "value"])).toEqual({
      present: true,
      value: "keep",
    });
    expect(readEntry({}, ["__proto__"])).toEqual({ present: false });
  });
});

test("concurrent independent edits merge, conflicting edits reject, and revisions are semantic", async () => {
  await fixture(async (path) => {
    await writeFile(path, '{"theme":"old","count":0}');
    const count = options(path);
    count.mutation = {
      path: ["count"],
      expectedRevision: entryRevision({ present: true, value: 0 }),
      change: { operation: "set", value: 1 },
    };
    const outcomes = await Promise.all([
      persistEntry(options(path)),
      persistEntry(count),
      persistEntry(options(path, "conflicting")),
    ]);
    expect(outcomes.map((outcome) => outcome.state)).toEqual([
      "persisted",
      "persisted",
      "rejected",
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      theme: "new",
      count: 1,
    });
    expect(entryRevision({ present: true, value: { a: 1, b: 2 } })).toBe(
      entryRevision({ present: true, value: { b: 2, a: 1 } }),
    );
    expect(entryRevision({ present: false })).not.toBe(
      entryRevision({ present: true, value: null }),
    );
  });
});

test("invalid edits and revoked trust do not write", async () => {
  await fixture(async (path) => {
    const request = options(path);
    request.validateEntry = () => ({
      valid: false,
      message: "synthetic-secret-invalid",
    });
    expect((await persistEntry(request)).state).toBe("rejected");
    expect(await Bun.file(path).exists()).toBe(false);
    const unavailable = await persistEntry({
      ...options(path),
      location: () => ({
        state: "unavailable",
        scope: "project",
        reason: "Project is not trusted.",
      }),
    });
    expect(unavailable.state).toBe("rejected");
    expect(await readdir(join(path, ".."))).toEqual([]);
  });
});
