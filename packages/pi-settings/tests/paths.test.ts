import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguration } from "../src/configuration-read.ts";
import { resolveConfigurationPath } from "../src/paths.ts";

test("custom agent and command directories resolve without creation on reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-paths-"));
  try {
    const context = {
      cwd: join(directory, "project"),
      isProjectTrusted: () => true,
    };
    const agent = () => join(directory, "custom-agent");
    for (const [kind, filename] of [
      ["native", "settings.json"],
      ["keybindings", "keybindings.json"],
      ["mcp", "mcp.json"],
      ["models", "models.json"],
    ] as const) {
      const location = resolveConfigurationPath(kind, "user", context, agent);
      expect(location).toEqual({
        state: "available",
        scope: "user",
        path: join(agent(), filename),
      });
      expect(await readConfiguration(location)).toEqual({
        state: "available",
        exists: false,
        value: {},
      });
    }
    const project = resolveConfigurationPath(
      "native",
      "project",
      context,
      agent,
    );
    expect(project).toEqual({
      state: "available",
      scope: "project",
      path: join(context.cwd, ".pi", "settings.json"),
    });
    expect(await readConfiguration(project)).toEqual({
      state: "available",
      exists: false,
      value: {},
    });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trust-gated files are not read and user-only scopes are not invented", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-trust-"));
  try {
    await mkdir(join(directory, ".pi"));
    await writeFile(
      join(directory, ".pi", "settings.json"),
      "malformed synthetic-secret",
    );
    const context = { cwd: directory, isProjectTrusted: () => false };
    for (const kind of ["native", "mcp", "models", "keybindings"] as const) {
      const location = resolveConfigurationPath(
        kind,
        "project",
        context,
        () => directory,
      );
      expect(location.state).toBe("unavailable");
      expect((await readConfiguration(location)).state).toBe("unavailable");
    }
    expect(
      (
        await readConfiguration(
          resolveConfigurationPath("native", "user", context, () => directory),
        )
      ).state,
    ).toBe("available");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads preserve unknown fields and return safe errors for malformed content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-read-"));
  try {
    const location = resolveConfigurationPath(
      "native",
      "user",
      { cwd: directory, isProjectTrusted: () => true },
      () => directory,
    );
    const path = join(directory, "settings.json");
    await writeFile(path, '\uFEFF{"future":{"field":true}}');
    expect(await readConfiguration(location)).toEqual({
      state: "available",
      exists: true,
      value: { future: { field: true } },
    });
    await writeFile(path, "synthetic-secret-not-json");
    const result = await readConfiguration(location);
    expect(result.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
