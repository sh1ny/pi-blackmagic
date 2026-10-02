import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EditResult,
  JsonValue,
  ScopedReadResult,
} from "../src/contracts.ts";
import { ModelsBackend } from "../src/models-backend.ts";
import { isMasked, MASKED_VALUE } from "../src/redaction.ts";

interface FixtureMetadata extends Record<string, JsonValue> {
  headers: Record<string, JsonValue>;
  compat: Record<string, JsonValue>;
}
interface FixtureOverrides extends Record<string, FixtureMetadata> {
  m: FixtureMetadata;
  builtin: FixtureMetadata;
  renamed: FixtureMetadata;
}
interface FixtureProvider extends FixtureMetadata {
  models: FixtureMetadata[];
  modelOverrides: FixtureOverrides;
  futureProvider: Record<string, JsonValue>;
}
interface FixtureProviders extends Record<string, FixtureProvider> {
  p: FixtureProvider;
  other: FixtureProvider;
}
interface FixtureRoot extends Record<string, JsonValue> {
  providers: FixtureProviders;
}

let directory: string;
let backend: ModelsBackend;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-settings-models-"));
  file = join(directory, "models.json");
  backend = new ModelsBackend(
    { cwd: join(directory, "project"), isProjectTrusted: () => false },
    () => directory,
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function root() {
  return JSON.parse(await readFile(file, "utf8")) as FixtureRoot;
}
async function seed(value: JsonValue) {
  await writeFile(file, JSON.stringify(value));
}
function available(result: ScopedReadResult) {
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error("Expected available read.");
  return result;
}
function persisted(result: EditResult) {
  expect(result.state).toBe("persisted");
  if (result.state !== "persisted")
    throw new Error("Expected persisted result.");
  expect(result.activation).toEqual({
    state: "required",
    requirement: "reload",
  });
  expect(result.read.effective).toEqual({ known: false });
  expect(result.read.provenance).toEqual({
    source: "user",
    sessionState: "unknown",
  });
  return result.read;
}
function draft(
  read: Extract<ScopedReadResult, { state: "available" }>,
): FixtureProvider {
  if (!read.configured.present) throw new Error("Expected provider.");
  return structuredClone(read.configured.value) as FixtureProvider;
}
async function revision(name = "p") {
  return available(await backend.readProvider(name)).revision;
}
async function provider(value: JsonValue = {}) {
  return persisted(await backend.writeProvider("p", value, await revision()));
}

describe("user-only credential-blind models backend", () => {
  test("constructor and missing reads do not materialize configuration or auth", async () => {
    let calls = 0;
    const absent = new ModelsBackend(
      {
        cwd: directory,
        isProjectTrusted: () => {
          throw new Error("must not inspect trust");
        },
      },
      () => {
        calls++;
        return join(directory, "absent");
      },
    );
    expect(calls).toBe(0);
    const read = available(await absent.readProvider("p"));
    expect(read.configured).toEqual({ present: false });
    expect(await readdir(directory)).toEqual([]);
    expect(calls).toBe(1);
  });
  test("denies all project operations without resolver, project files, or trust checks", async () => {
    const denied = new ModelsBackend(
      {
        cwd: directory,
        isProjectTrusted: () => {
          throw new Error("not called");
        },
      },
      () => {
        throw new Error("not called");
      },
    );
    expect((await denied.readProvider("p", "project")).state).toBe(
      "unavailable",
    );
    for (const result of await Promise.all([
      denied.writeProvider("p", {}, "absent", "project"),
      denied.renameProvider("p", "q", "absent", "project"),
      denied.deleteProvider("p", "absent", "project"),
      denied.addModel("p", { id: "m" }, "absent", "project"),
      denied.editModel("p", "m", { id: "m" }, "absent", "project"),
      denied.renameModel("p", "m", "n", "absent", "project"),
      denied.deleteModel("p", "m", "absent", "project"),
      denied.writeOverride("p", "m", {}, "absent", "project"),
      denied.renameOverride("p", "m", "n", "absent", "project"),
      denied.deleteOverride("p", "m", "absent", "project"),
    ]))
      expect(result).toMatchObject({
        state: "rejected",
        reason: "unavailable",
      });
    expect(await readdir(directory)).toEqual([]);
  });
  test("provider create/edit/rename/delete preserve unrelated providers and root content", async () => {
    await seed({
      providers: { unrelated: { name: "untouched", future: [1] } },
      futureRoot: { keep: true },
    });
    let read = await provider({
      baseUrl: "https://local.invalid",
      models: [{ id: "m" }],
      futureProvider: { keep: true },
    });
    read = persisted(
      await backend.writeProvider(
        "p",
        { ...draft(read), name: "edited" },
        read.revision,
      ),
    );
    read = persisted(
      await backend.renameProvider("p", "renamed", read.revision),
    );
    expect(draft(read).name).toBe("edited");
    expect(available(await backend.readProvider("p")).configured.present).toBe(
      false,
    );
    const deleted = persisted(
      await backend.deleteProvider("renamed", read.revision),
    );
    expect(deleted.configured).toEqual({ present: false });
    expect<JsonValue>(await root()).toEqual({
      providers: { unrelated: { name: "untouched", future: [1] } },
      futureRoot: { keep: true },
    });
  });
  test("BOM and baseline JSON comments load and persist without altering URL or literals", async () => {
    await writeFile(
      file,
      '\uFEFF{ /* provider definitions */ "providers": { "p": { "baseUrl": "https://example.invalid/path//literal", "apiKey": "!echo /*literal*/" } } // end\n }',
    );
    const read = available(await backend.readProvider("p"));
    persisted(
      await backend.writeProvider(
        "p",
        { ...draft(read), name: "edited" },
        read.revision,
      ),
    );
    expect((await root()).providers.p.apiKey).toBe("!echo /*literal*/");
    expect((await root()).providers.p.baseUrl).toBe(
      "https://example.invalid/path//literal",
    );
  });
  test("malformed JSON and invalid known fields are never overwritten; diagnostics are safe", async () => {
    for (const content of [
      '{"providers": {"p": {"apiKey": "private-marker"}',
      '{"providers":{"p":{"apiKey":"private-marker","models":[{"id":""}]}}}',
      "{}",
      "[]",
    ]) {
      await writeFile(file, content);
      const read = await backend.readProvider("p");
      expect(read.state).toBe("error");
      const result = await backend.writeProvider("p", {}, "irrelevant");
      expect(result.state).toBe("failed");
      expect(JSON.stringify([read, result])).not.toContain("private-marker");
      expect(await readFile(file, "utf8")).toBe(content);
    }
  });
  test("invalid complete entries do not create a missing file or partially save a provider", async () => {
    expect(
      await backend.writeProvider(
        "p",
        { apiKey: "private-marker", models: [{ id: "" }] },
        await revision(),
      ),
    ).toMatchObject({ state: "rejected", reason: "validation" });
    expect(await readdir(directory)).toEqual([]);
    const read = await provider({ models: [{ id: "m" }] });
    const before = await readFile(file, "utf8");
    expect(
      await backend.editModel(
        "p",
        "m",
        { id: "m", promptCache: { short: 0 } },
        read.revision,
      ),
    ).toMatchObject({ state: "rejected", reason: "validation" });
    expect(
      await backend.writeOverride(
        "p",
        "m",
        { cost: { tiers: [{}] } },
        read.revision,
      ),
    ).toMatchObject({ state: "rejected", reason: "validation" });
    expect(await readFile(file, "utf8")).toBe(before);
  });
  test("provider conflicts reject stale drafts while unrelated external updates merge", async () => {
    let read = await provider({ name: "original" });
    await seed({
      providers: { p: { name: "original" }, other: { name: "external" } },
      rootExternal: true,
    });
    read = persisted(
      await backend.writeProvider("p", { name: "edited" }, read.revision),
    );
    expect((await root()).providers.other.name).toBe("external");
    expect((await root()).rootExternal).toBe(true);
    await seed({
      ...(await root()),
      providers: { ...(await root()).providers, p: { name: "newer" } },
    });
    expect(
      await backend.writeProvider("p", { name: "stale" }, read.revision),
    ).toMatchObject({ state: "rejected", reason: "conflict" });
    expect(await backend.deleteProvider("p", read.revision)).toMatchObject({
      state: "rejected",
      reason: "conflict",
    });
    expect(
      await backend.renameProvider("p", "renamed", read.revision),
    ).toMatchObject({ state: "rejected", reason: "conflict" });
    expect((await root()).providers.p.name).toBe("newer");
  });
  test("concurrent same-provider writes have one acknowledgement and one conflict", async () => {
    const read = await provider({ name: "initial" });
    const results = await Promise.all([
      backend.writeProvider("p", { name: "one" }, read.revision),
      backend.writeProvider("p", { name: "two" }, read.revision),
    ]);
    expect(
      results.filter((result) => result.state === "persisted"),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.state === "rejected" && result.reason === "conflict",
      ),
    ).toHaveLength(1);
  });
  test("concurrent distinct providers merge under shared persistence queue", async () => {
    const revisions = await Promise.all([revision("p"), revision("q")]);
    const results = await Promise.all([
      backend.writeProvider("p", {}, revisions[0] as string),
      backend.writeProvider("q", {}, revisions[1] as string),
    ]);
    results.forEach(persisted);
    expect(Object.keys((await root()).providers).sort()).toEqual(["p", "q"]);
  });
  test("rename collisions and missing sources are rejected atomically", async () => {
    const read = await provider({
      models: [{ id: "a" }, { id: "b" }],
      modelOverrides: { a: {}, b: {} },
    });
    persisted(await backend.writeProvider("q", {}, await revision("q")));
    const before = await readFile(file, "utf8");
    for (const result of [
      await backend.renameProvider("p", "q", read.revision),
      await backend.renameModel("p", "a", "b", read.revision),
      await backend.renameOverride("p", "a", "b", read.revision),
      await backend.addModel("p", { id: "a" }, read.revision),
    ])
      expect(result).toMatchObject({ state: "rejected", reason: "conflict" });
    for (const result of [
      await backend.renameProvider("missing", "new", await revision("missing")),
      await backend.editModel("p", "missing", { id: "missing" }, read.revision),
      await backend.deleteModel("p", "missing", read.revision),
      await backend.renameOverride("p", "missing", "new", read.revision),
      await backend.deleteOverride("p", "missing", read.revision),
    ])
      expect(result).toMatchObject({ state: "rejected", reason: "validation" });
    expect(await readFile(file, "utf8")).toBe(before);
  });
  test("models create/edit/rename/delete and overrides create/edit/rename/delete use provider revisions", async () => {
    let read = await provider({ models: [{ id: "other" }], future: 1 });
    read = persisted(
      await backend.addModel(
        "p",
        { id: "m", name: "Model", futureModel: true },
        read.revision,
      ),
    );
    const modelRevision = read.revision;
    read = persisted(
      await backend.writeOverride(
        "p",
        "m",
        { name: "Override", futureOverride: true },
        read.revision,
      ),
    );
    expect(
      await backend.editModel(
        "p",
        "m",
        { id: "m", name: "stale" },
        modelRevision,
      ),
    ).toMatchObject({ state: "rejected", reason: "conflict" });
    read = persisted(
      await backend.editModel(
        "p",
        "m",
        { id: "m", name: "edited" },
        read.revision,
      ),
    );
    expect<JsonValue>((await root()).providers.p.models[1] ?? null).toEqual({
      id: "m",
      name: "edited",
      futureModel: true,
    });
    read = persisted(
      await backend.writeOverride(
        "p",
        "m",
        { cost: { input: 1 } },
        read.revision,
      ),
    );
    expect<JsonValue>((await root()).providers.p.modelOverrides.m).toEqual({
      cost: { input: 1 },
      futureOverride: true,
    });
    read = persisted(
      await backend.renameModel("p", "m", "renamed", read.revision),
    );
    expect(
      (await root()).providers.p.modelOverrides.renamed.futureOverride,
    ).toBe(true);
    read = persisted(
      await backend.renameOverride("p", "renamed", "builtin", read.revision),
    );
    read = persisted(await backend.deleteModel("p", "renamed", read.revision));
    expect(
      (await root()).providers.p.modelOverrides.builtin.futureOverride,
    ).toBe(true);
    read = persisted(
      await backend.deleteOverride("p", "builtin", read.revision),
    );
    expect<JsonValue>((await root()).providers.p).toEqual({
      models: [{ id: "other" }],
      modelOverrides: {},
      future: 1,
    });
    expect<JsonValue>(draft(read).models).toEqual([{ id: "other" }]);
  });
  test("baseline duplicate models are readable but ambiguous identity mutations are blocked", async () => {
    const read = await provider({ models: [{ id: "m" }, { id: "m" }] });
    for (const result of [
      await backend.editModel("p", "m", { id: "m" }, read.revision),
      await backend.renameModel("p", "m", "n", read.revision),
      await backend.deleteModel("p", "m", read.revision),
    ])
      expect(result).toMatchObject({ state: "rejected", reason: "validation" });
  });
  test("complete masked drafts preserve each duplicate model's unchanged secrets", async () => {
    const read = await provider({
      models: [
        { id: "m", headers: { Authorization: "first-private" } },
        { id: "m", headers: { Authorization: "second-private" } },
      ],
    });
    persisted(
      await backend.writeProvider(
        "p",
        { ...draft(read), name: "edited" },
        read.revision,
      ),
    );
    const models = (await root()).providers.p.models;
    expect(models[0]?.headers.Authorization).toBe("first-private");
    expect(models[1]?.headers.Authorization).toBe("second-private");
  });
  test("deleting the first duplicate retains the second model's masked and omitted future fields", async () => {
    const first = {
      id: "m",
      headers: { Authorization: "first-private" },
      futureModel: { secret: "first-future-private" },
      futureOmitted: { owner: "first" },
      compat: { futureCompat: { owner: "first" } },
    };
    const second = {
      id: "m",
      headers: { Authorization: "second-private" },
      futureModel: { secret: "second-future-private" },
      futureOmitted: { owner: "second" },
      compat: { futureCompat: { owner: "second" } },
    };
    const read = await provider({ models: [first, second] });
    const value = draft(read);
    value.models.shift();
    const retained = value.models[0];
    if (!retained) throw new Error("Expected retained duplicate fixture.");
    expect(isMasked(retained.headers.Authorization ?? null)).toBe(true);
    expect(isMasked(retained.futureModel ?? null)).toBe(true);
    delete retained.futureOmitted;
    retained.compat = {};
    const result = await backend.writeProvider("p", value, read.revision);
    persisted(result);
    for (const secret of [
      "first-private",
      "second-private",
      "first-future-private",
      "second-future-private",
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect<JsonValue>((await root()).providers.p.models).toEqual([second]);
  });
  test("masked provider/model/override drafts retain secrets and future fields, including model reordering", async () => {
    const read = await provider({
      apiKey: "key-private",
      headers: { Authorization: "header-private" },
      futureProvider: { secret: "future-private" },
      compat: { supportsStore: true, futureCompat: 1 },
      models: [
        {
          id: "a",
          headers: { Authorization: "a-private" },
          samplingParams: { future: true },
          futureModel: 1,
        },
        { id: "b", headers: { Authorization: "b-private" } },
      ],
      modelOverrides: {
        builtin: {
          headers: { Authorization: "override-private" },
          futureOverride: 2,
        },
      },
    });
    const value = draft(read);
    for (const secret of [
      "key-private",
      "header-private",
      "future-private",
      "a-private",
      "b-private",
      "override-private",
    ])
      expect(JSON.stringify(value)).not.toContain(secret);
    expect(isMasked(value.apiKey ?? null)).toBe(true);
    value.models.reverse();
    value.name = "changed";
    persisted(await backend.writeProvider("p", value, read.revision));
    const saved = (await root()).providers.p;
    expect(saved.apiKey).toBe("key-private");
    expect(saved.headers.Authorization).toBe("header-private");
    expect(saved.models[0]?.headers.Authorization).toBe("b-private");
    expect(saved.models[1]?.headers.Authorization).toBe("a-private");
    expect(saved.modelOverrides.builtin.headers.Authorization).toBe(
      "override-private",
    );
    expect(saved.futureProvider.secret).toBe("future-private");
    const newer = available(await backend.readProvider("p"));
    const model = draft(newer).models[1];
    if (!model) throw new Error("Expected second model fixture.");
    model.name = "model edit";
    const edited = persisted(
      await backend.editModel("p", "a", model, newer.revision),
    );
    const override = draft(edited).modelOverrides.builtin;
    override.name = "override edit";
    persisted(
      await backend.writeOverride("p", "builtin", override, edited.revision),
    );
    expect((await root()).providers.p.models[1]?.headers.Authorization).toBe(
      "a-private",
    );
    expect(
      (await root()).providers.p.modelOverrides.builtin.headers.Authorization,
    ).toBe("override-private");
  });
  test("explicit replacements including empty headers work; new masks cannot invent credentials", async () => {
    let read = await provider({
      apiKey: "old-private",
      headers: { Authorization: "old-private" },
    });
    const value = draft(read);
    value.apiKey = "ENV_REFERENCE";
    value.headers.Authorization = "";
    read = persisted(await backend.writeProvider("p", value, read.revision));
    expect((await root()).providers.p.apiKey).toBe("ENV_REFERENCE");
    expect((await root()).providers.p.headers.Authorization).toBe("");
    const before = await readFile(file, "utf8");
    expect(
      (
        await backend.writeOverride(
          "p",
          "new",
          { headers: { Authorization: MASKED_VALUE } },
          read.revision,
        )
      ).state,
    ).toBe("failed");
    expect(
      (
        await backend.writeProvider(
          "new",
          { apiKey: MASKED_VALUE },
          await revision("new"),
        )
      ).state,
    ).toBe("failed");
    expect(await readFile(file, "utf8")).toBe(before);
  });
  test("new models reject nested legacy and opaque masks without changing the file", async () => {
    const read = await provider({ apiKey: "existing-private", models: [] });
    const before = await readFile(file, "utf8");
    const opaque = draft(read).apiKey;
    if (!opaque || !isMasked(opaque))
      throw new Error("Expected opaque mask fixture.");
    for (const marker of [
      MASKED_VALUE,
      opaque,
      { ...MASKED_VALUE, $token: "unresolved-token" },
    ]) {
      for (const field of ["samplingParams", "futureModel"]) {
        const result = await backend.addModel(
          "p",
          { id: "new", [field]: { nested: [{ retained: marker }] } },
          read.revision,
        );
        expect(result).toMatchObject({
          state: "rejected",
          reason: "validation",
        });
        expect(JSON.stringify(result)).not.toContain("existing-private");
        expect(JSON.stringify(result)).not.toContain("unresolved-token");
        expect(await readFile(file, "utf8")).toBe(before);
      }
    }
  });
  test("future fields survive sparse complete-entry updates and prototype-like keys are ordinary data", async () => {
    const value = JSON.parse(
      '{"apiKey":"literal","futureProvider":{"keep":true},"compat":{"supportsStore":true,"futureCompat":{"keep":true}},"models":[{"id":"m","futureModel":true}],"modelOverrides":{"__proto__":{"name":"override","futureOverride":true}},"__proto__":{"future":true}}',
    );
    let read = await provider(value);
    read = persisted(
      await backend.writeProvider(
        "p",
        {
          compat: { supportsStore: false },
          models: [{ id: "m", name: "edited" }],
          modelOverrides: { ["__proto__"]: { name: "edited" } },
        },
        read.revision,
      ),
    );
    const saved = (await root()).providers.p;
    expect(saved.futureProvider).toEqual({ keep: true });
    expect(saved.compat.futureCompat).toEqual({ keep: true });
    expect(saved.models[0]?.futureModel).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(saved.modelOverrides, "__proto__")?.value
        .futureOverride,
    ).toBe(true);
    expect(Object.hasOwn(saved, "__proto__")).toBe(true);
    read = persisted(
      await backend.renameOverride(
        "p",
        "__proto__",
        "constructor",
        read.revision,
      ),
    );
    persisted(await backend.renameProvider("p", "__proto__", read.revision));
    expect(Object.hasOwn((await root()).providers, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).future).toBeUndefined();
  });
  test("never executes credential commands, probes endpoints, reads auth, or selects a session model", async () => {
    const marker = join(directory, "executed");
    const command = `!node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'executed')"`;
    const auth = "not-json-auth-store-should-not-be-read";
    await writeFile(join(directory, "auth.json"), auth);
    const read = await provider({
      apiKey: command,
      baseUrl: "http://127.0.0.1:1",
      headers: { Authorization: command },
      models: [
        { id: "m", api: "custom-api", headers: { Authorization: command } },
      ],
    });
    persisted(await backend.renameModel("p", "m", "renamed", read.revision));
    expect((await root()).providers.p.apiKey).toBe(command);
    expect(await readFile(join(directory, "auth.json"), "utf8")).toBe(auth);
    expect((await readdir(directory)).sort()).toEqual([
      "auth.json",
      "models.json",
    ]);
    const source = await readFile(
      new URL("../src/models-backend.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /ModelRegistry|ModelConfig|child_process|fetch\(|setModel\(|auth\.json/,
    );
  });
  test("resolver exceptions and missing model/provider diagnostics do not reveal sensitive text", async () => {
    const broken = new ModelsBackend(
      { cwd: directory, isProjectTrusted: () => false },
      () => {
        throw new Error("private-marker");
      },
    );
    const results = [
      await broken.readProvider("p"),
      await broken.writeProvider("p", {}, "revision"),
      await backend.addModel("absent", { id: "m" }, await revision("absent")),
    ];
    expect(JSON.stringify(results)).not.toContain("private-marker");
    expect(results.map((result) => result.state)).toEqual([
      "error",
      "failed",
      "rejected",
    ]);
  });
});
