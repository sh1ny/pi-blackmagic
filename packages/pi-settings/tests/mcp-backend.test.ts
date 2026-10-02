import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, ScopedReadResult } from "../src/contracts.ts";
import { McpBackend } from "../src/mcp-backend.ts";
import { entryRevision, persistEntry } from "../src/persistence.ts";
import { MASKED_VALUE } from "../src/redaction.ts";

function available(result: ScopedReadResult) {
  if (result.state !== "available") throw new Error("Expected available read.");
  return result;
}
function configured(result: ScopedReadResult): JsonValue {
  const read = available(result);
  if (!read.configured.present) throw new Error("Expected configured entry.");
  return read.configured.value;
}
function effective(result: ScopedReadResult): JsonValue {
  const read = available(result);
  if (!read.effective.known) throw new Error("Expected known effective entry.");
  return read.effective.value;
}

describe("MCP storage backend (temporary configuration only)", () => {
  let temporary: string;
  let agent: string;
  let project: string;
  let trusted: boolean;
  let backend: McpBackend;
  const file = () => join(agent, "mcp.json");
  const projectFile = () => join(project, ".pi", "mcp.json");
  async function put(scope: "user" | "project", value: JsonValue) {
    await mkdir(scope === "user" ? agent : join(project, ".pi"), {
      recursive: true,
    });
    await writeFile(
      scope === "user" ? file() : projectFile(),
      JSON.stringify(value),
    );
  }
  async function stored(scope: "user" | "project" = "user") {
    return JSON.parse(
      await readFile(scope === "user" ? file() : projectFile(), "utf8"),
    );
  }
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "pi-settings-mcp-"));
    agent = join(temporary, "agent");
    project = join(temporary, "project");
    trusted = true;
    backend = new McpBackend(
      { cwd: project, isProjectTrusted: () => trusted },
      () => agent,
    );
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  test("wildcard exposure order is revision-significant in reads and locked writes", async () => {
    const first = {
      command: "literal",
      toolExposure: { "read_*": "direct", "*": "hidden" },
    };
    const reordered = {
      command: "literal",
      toolExposure: { "*": "hidden", "read_*": "direct" },
    };
    await put("user", { mcpServers: { same: first } });
    const baseline = available(await backend.readDraft("same", "user"));
    await put("user", { mcpServers: { same: reordered } });
    const current = available(await backend.readDraft("same", "user"));
    expect(current.revision).not.toBe(baseline.revision);
    const before = await readFile(file(), "utf8");
    expect(
      (
        await backend.writeServer("same", "user", baseline.revision, {
          ...first,
          timeout: 200,
        })
      ).state,
    ).toBe("rejected");
    const locked = await persistEntry({
      location: () => ({ state: "available", path: file(), scope: "user" }),
      mutation: {
        path: ["mcpServers", "same"],
        expectedRevision: baseline.revision,
        change: { operation: "set", value: first },
      },
      revisionOf: (entry) => entryRevision(entry, [["toolExposure"]]),
      validateEntry: () => ({ valid: true }),
      validateConfiguration: () => ({ valid: true }),
    });
    expect(locked.state).toBe("rejected");
    expect(await readFile(file(), "utf8")).toBe(before);
    expect(
      (
        await backend.writeServer("same", "user", current.revision, {
          ...reordered,
          timeout: 200,
        })
      ).state,
    ).toBe("persisted");
    expect(Object.keys((await stored()).mcpServers.same.toolExposure)).toEqual([
      "*",
      "read_*",
    ]);
  });

  test("missing-file reads and cancelled creation never materialize anything", async () => {
    const read = available(await backend.readDraft("new", "project"));
    expect(read.configured).toEqual({ present: false });
    expect(read.effective).toEqual({ known: false });
    expect(read.revision).toBe(entryRevision({ present: false }));
    const draft = { command: "literal" }; // Cancelling means not calling writeServer.
    expect(draft.command).toBe("literal");
    expect(
      effective(await backend.readRootOption("autoEnableCodemode", "user")),
    ).toBe(true);
    expect(await readdir(temporary)).toEqual([]);
  });
  test("untrusted project is never loaded or written, and user reads remain available", async () => {
    await put("user", { mcpServers: { same: { command: "user" } } });
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(projectFile(), "malformed project content");
    trusted = false;
    expect((await backend.readDraft("same", "project")).state).toBe(
      "unavailable",
    );
    expect(effective(await backend.readDraft("same", "user"))).toEqual({
      command: "user",
    });
    expect(
      (
        await backend.writeServer(
          "same",
          "project",
          entryRevision({ present: false }),
          { command: "literal" },
        )
      ).state,
    ).toBe("rejected");
    expect(await readFile(projectFile(), "utf8")).toBe(
      "malformed project content",
    );
  });
  test("project replaces same-named user entries; deletion reveals the whole inherited entry", async () => {
    const user = {
      command: "user",
      args: ["one"],
      env: { TOKEN: "synthetic-secret" },
    };
    const local = {
      url: "https://example.invalid/mcp",
      headers: { Authorization: "synthetic-project-secret" },
      enabled: false,
    };
    await put("user", { mcpServers: { same: user } });
    await put("project", { mcpServers: { same: local } });
    const read = available(await backend.readServer("same", "project"));
    expect(read.configured).toEqual({ present: true, value: local });
    expect(effective(read)).toEqual(local);
    expect(read.provenance).toEqual({
      source: "project",
      sessionState: "unknown",
    });
    expect(effective(await backend.readServer("same", "user"))).toEqual(local);
    const result = await backend.removeOverride(
      "same",
      "project",
      read.revision,
    );
    expect(result.state).toBe("persisted");
    if (result.state !== "persisted")
      throw new Error("Expected acknowledged persistence.");
    expect(result.read.configured).toEqual({ present: false });
    expect(result.read.provenance.source).toBe("user");
    expect(effective(await backend.readServer("same", "project"))).toEqual(
      user,
    );
    expect((await stored("user")).mcpServers.same).toEqual(user);
    expect((await stored("project")).mcpServers).toEqual({});
  });
  test("root inheritance, project removal, explicit reload, and disabled servers", async () => {
    await put("user", {
      autoEnableCodemode: false,
      mcpServers: { disabled: { command: "literal", enabled: false } },
    });
    const read = available(
      await backend.readRootOption("autoEnableCodemode", "project"),
    );
    expect(read.configured.present).toBe(false);
    expect(effective(read)).toBe(false);
    expect(read.provenance.source).toBe("user");
    const result = await backend.writeRootOption(
      "autoEnableCodemode",
      "project",
      read.revision,
      true,
    );
    expect(result.state).toBe("persisted");
    if (result.state !== "persisted") throw new Error("Expected persistence.");
    expect(result.activation).toEqual({
      state: "required",
      requirement: "reload",
    });
    expect(effective(result.read)).toBe(true);
    expect(
      (
        await backend.removeRootOption(
          "autoEnableCodemode",
          "project",
          result.read.revision,
        )
      ).state,
    ).toBe("persisted");
    expect(
      effective(await backend.readRootOption("autoEnableCodemode", "project")),
    ).toBe(false);
    expect(effective(await backend.readServer("disabled", "user"))).toEqual({
      command: "literal",
      enabled: false,
    });
    expect(
      (
        await backend.writeRootOption(
          "unsupported",
          "user",
          read.revision,
          true,
        )
      ).state,
    ).toBe("rejected");
  });
  test("coherent creation, full entry replacement, external unrelated edits and unknown fields", async () => {
    const absent = available(await backend.readServer("created", "user"));
    await put("user", {
      futureRoot: { untouched: 1 },
      mcpServers: { other: { command: "other", future: { retained: true } } },
    });
    const value = {
      command: "literal",
      args: ["--literal"],
      env: { TOKEN: `\${UNRESOLVED_TOKEN}` },
      cwd: "relative",
      enabled: false,
      exposure: "hidden",
      toolExposure: { "read_*": "direct" },
      timeout: 7,
      unknownFuture: "opaque",
    };
    const created = await backend.writeServer(
      "created",
      "user",
      absent.revision,
      value,
    );
    expect(created.state).toBe("persisted");
    expect((await stored()).mcpServers.created).toEqual(value);
    const baseline = available(await backend.readDraft("created", "user"));
    const external = await stored();
    external.mcpServers.other.args = ["external-change"];
    await put("user", external);
    const saved = await backend.writeServer(
      "created",
      "user",
      baseline.revision,
      { url: "https://example.invalid/mcp" },
    );
    expect(saved.state).toBe("persisted");
    expect(await stored()).toEqual({
      futureRoot: { untouched: 1 },
      mcpServers: {
        other: {
          command: "other",
          future: { retained: true },
          args: ["external-change"],
        },
        created: { url: "https://example.invalid/mcp" },
      },
    });
    expect((await readdir(agent)).sort()).toEqual(["mcp.json"]);
  });
  test("same-entry revision conflicts and concurrent independent writes", async () => {
    await put("user", {
      mcpServers: {
        first: { command: "first" },
        second: { command: "second" },
      },
    });
    const first = available(await backend.readServer("first", "user"));
    const second = available(await backend.readServer("second", "user"));
    const results = await Promise.all([
      backend.writeServer("first", "user", first.revision, {
        command: "new-first",
      }),
      backend.writeServer("second", "user", second.revision, {
        command: "new-second",
      }),
    ]);
    expect(results.map((result) => result.state)).toEqual([
      "persisted",
      "persisted",
    ]);
    expect(
      await backend.writeServer("first", "user", first.revision, {
        command: "stale",
      }),
    ).toMatchObject({ state: "rejected", reason: "conflict" });
    expect(
      await backend.deleteServer("first", "user", first.revision),
    ).toMatchObject({ state: "rejected", reason: "conflict" });
    expect((await stored()).mcpServers.first.command).toBe("new-first");
  });
  test("rename is one entry transaction, rejects collisions, and preserves unrelated content", async () => {
    await put("user", {
      future: 1,
      mcpServers: {
        source: {
          command: "literal",
          env: { TOKEN: "secret" },
          future: { private: "unknown-secret" },
        },
        target: { command: "target" },
      },
    });
    const read = available(await backend.readDraft("source", "user"));
    expect(
      await backend.renameServer("source", "user", read.revision, "target"),
    ).toMatchObject({ state: "rejected", reason: "conflict" });
    expect(
      await backend.renameServer("source", "user", read.revision, "bad.name"),
    ).toMatchObject({ state: "rejected", reason: "validation" });
    const saved = await backend.renameServer(
      "source",
      "user",
      read.revision,
      "renamed",
      configured(read),
    );
    expect(saved.state).toBe("persisted");
    expect(await stored()).toEqual({
      future: 1,
      mcpServers: {
        target: { command: "target" },
        renamed: {
          command: "literal",
          env: { TOKEN: "secret" },
          future: { private: "unknown-secret" },
        },
      },
    });
    const absent = available(await backend.readServer("absent", "project"));
    expect(
      (await backend.renameServer("absent", "project", absent.revision, "new"))
        .state,
    ).toBe("rejected");
  });
  test("masked drafts retain unchanged env, headers, OAuth and unknown fields; acknowledgements are masked", async () => {
    const secret = "SYNTHETIC_SECRET_MUST_NOT_LEAK";
    const original = {
      url: "https://example.invalid/mcp",
      headers: { Authorization: secret, Custom: `\${REF}` },
      oauth: { clientSecret: secret, clientId: "public-id" },
      unknownFuture: { opaqueSecret: secret },
      timeout: 60,
    };
    await put("user", {
      mcpServers: {
        remote: original,
        local: { command: "literal", env: { TOKEN: secret } },
      },
    });
    const read = available(await backend.readDraft("remote", "user"));
    expect(JSON.stringify(read)).not.toContain(secret);
    const draft = configured(read) as Record<string, JsonValue>;
    draft.timeout = 75;
    const saved = await backend.writeServer(
      "remote",
      "user",
      read.revision,
      draft,
    );
    expect(saved.state).toBe("persisted");
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect((await stored()).mcpServers.remote).toEqual({
      ...original,
      timeout: 75,
    });
    const next = available(await backend.readDraft("remote", "user"));
    const deliberate = configured(next) as Record<string, JsonValue>;
    (deliberate.headers as Record<string, JsonValue>).Authorization = "";
    (deliberate.oauth as Record<string, JsonValue>).clientSecret =
      `\${NEW_REFERENCE}`;
    expect(
      (await backend.writeServer("remote", "user", next.revision, deliberate))
        .state,
    ).toBe("persisted");
    expect((await stored()).mcpServers.remote.headers.Authorization).toBe("");
    expect((await stored()).mcpServers.remote.oauth.clientSecret).toBe(
      `\${NEW_REFERENCE}`,
    );
    const local = available(await backend.readDraft("local", "user"));
    const localDraft = configured(local) as Record<string, JsonValue>;
    localDraft.args = ["new"];
    expect(
      (await backend.writeServer("local", "user", local.revision, localDraft))
        .state,
    ).toBe("persisted");
    expect((await stored()).mcpServers.local.env.TOKEN).toBe(secret);
    const absent = available(await backend.readDraft("missing", "user"));
    const bad = await backend.writeServer("missing", "user", absent.revision, {
      command: "literal",
      env: { TOKEN: { ...MASKED_VALUE } },
    });
    expect(bad.state).toBe("rejected");
    expect(JSON.stringify(bad)).not.toContain(secret);
  });
  test("masked inherited drafts can create project replacements without reading credential stores", async () => {
    await put("user", {
      mcpServers: {
        inherited: { command: "literal", env: { TOKEN: "synthetic" } },
      },
    });
    await writeFile(
      join(agent, "mcp-auth.json"),
      "malformed must never be read",
    );
    const read = available(await backend.readDraft("inherited", "project"));
    const draft = effective(read) as Record<string, JsonValue>;
    draft.enabled = false;
    expect(
      (await backend.writeServer("inherited", "project", read.revision, draft))
        .state,
    ).toBe("persisted");
    expect((await stored("project")).mcpServers.inherited).toEqual({
      command: "literal",
      env: { TOKEN: "synthetic" },
      enabled: false,
    });
    expect(await readFile(join(agent, "mcp-auth.json"), "utf8")).toBe(
      "malformed must never be read",
    );
  });
  test("trust revocation after draft opening and during write blocks persistence", async () => {
    const read = available(await backend.readDraft("new", "project"));
    trusted = false;
    expect(
      await backend.writeServer("new", "project", read.revision, {
        command: "literal",
      }),
    ).toMatchObject({ state: "rejected", reason: "unavailable" });
    expect(await readdir(temporary)).toEqual([]);
    let checks = 0;
    const revoking = new McpBackend(
      { cwd: project, isProjectTrusted: () => ++checks < 6 },
      () => agent,
    );
    expect(
      await revoking.writeRootOption(
        "autoEnableCodemode",
        "project",
        entryRevision({ present: false }),
        false,
      ),
    ).toMatchObject({ state: "rejected", reason: "unavailable" });
    expect(
      await access(projectFile()).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  test("invalid entries, invalid roots and malformed files are not overwritten; diagnostics stay safe", async () => {
    const secret = "SYNTHETIC_PARSE_ERROR_SECRET";
    const malformed = `{"mcpServers": {"${secret}":`;
    const absent = entryRevision({ present: false });
    expect(
      (
        await backend.writeServer("bad.name", "user", absent, {
          command: secret,
        })
      ).state,
    ).toBe("rejected");
    expect(
      (
        await backend.writeServer("valid", "user", absent, {
          command: secret,
          url: secret,
        })
      ).state,
    ).toBe("rejected");
    expect(await readdir(temporary)).toEqual([]);
    for (const text of [
      malformed,
      "[]",
      "null",
      JSON.stringify({ mcpServers: [] }),
      JSON.stringify({ autoEnableCodemode: secret }),
      JSON.stringify({ mcpServers: { invalid: { type: "sse", url: secret } } }),
    ]) {
      await mkdir(agent, { recursive: true });
      await writeFile(file(), text);
      expect((await backend.readDraft("valid", "user")).state).toBe("error");
      const result = await backend.writeServer("valid", "user", absent, {
        command: "literal",
      });
      expect(result.state).not.toBe("persisted");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(
        (
          await backend.writeRootOption(
            "autoEnableCodemode",
            "user",
            absent,
            false,
          )
        ).state,
      ).not.toBe("persisted");
      expect(await readFile(file(), "utf8")).toBe(text);
    }
  });
  test("credential expressions, executable literals and URL endpoints cause no side effects", async () => {
    const marker = join(temporary, "NEVER_CREATED");
    const expression = `!node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe")'`;
    await put("user", {
      mcpServers: {
        local: {
          command: "node",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
          ],
          env: { TOKEN: expression },
        },
        remote: {
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: expression },
          oauth: { clientSecret: expression },
        },
      },
    });
    for (const name of ["local", "remote"]) {
      const read = available(await backend.readDraft(name, "user"));
      expect(
        (
          await backend.writeServer(
            name,
            "user",
            read.revision,
            configured(read),
          )
        ).state,
      ).toBe("persisted");
    }
    expect(
      await access(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect((await stored()).mcpServers.local.env.TOKEN).toBe(expression);
    expect((await stored()).mcpServers.remote.oauth.clientSecret).toBe(
      expression,
    );
  });
});
