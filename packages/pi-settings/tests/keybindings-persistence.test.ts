import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsBackend } from "../src/keybindings-backend.ts";
import future from "./fixtures/unknown-future-fields.json";

async function fixture(
  run: (backend: KeybindingsBackend, path: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-keys-write-"));
  try {
    const path = join(directory, "keybindings.json");
    await writeFile(
      path,
      JSON.stringify({ ...future.keybindings, "app.clear": "+" }),
    );
    const backend = new KeybindingsBackend(
      { cwd: directory, isProjectTrusted: () => false },
      undefined,
      () => directory,
    );
    await run(backend, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function revision(backend: KeybindingsBackend, action: string) {
  const read = await backend.readAction(action);
  if (read.state !== "available")
    throw new Error("Missing synthetic assignment");
  return read.revision;
}

test("single/multiple assignments, disabled actions, and reset persist with reload feedback", async () => {
  await fixture(async (backend, path) => {
    const action = "app.session.new";
    for (const value of ["ctrl+shift+n", ["ctrl+shift+n", "alt+shift+n"], []]) {
      const saved = await backend.writeAction(
        action,
        "user",
        await revision(backend, action),
        value,
      );
      expect(saved.state).toBe("persisted");
      if (saved.state !== "persisted")
        throw new Error("Missing acknowledgement");
      expect(saved.activation).toEqual({
        state: "required",
        requirement: "reload",
      });
      expect(JSON.parse(await readFile(path, "utf8"))[action]).toEqual(value);
    }
    expect(
      (
        await backend.removeOverride(
          action,
          "user",
          await revision(backend, action),
        )
      ).state,
    ).toBe("persisted");
    const restored = await backend.readAction(action);
    if (restored.state !== "available")
      throw new Error("Missing restored default");
    expect(restored.configured.present).toBe(false);
    expect(restored.effective).toEqual({ known: true, value: [] });
    const root = JSON.parse(await readFile(path, "utf8"));
    expect(root["app.future.action"]).toEqual(["ctrl+f12"]);
    expect(root["app.clear"]).toBe("+");
  });
});

test("invalid/plus syntax, same-entry conflicts, and project writes leave stored values unchanged", async () => {
  await fixture(async (backend, path) => {
    const action = "app.session.new";
    const baseline = await revision(backend, action);
    expect(
      (await backend.writeAction(action, "project", baseline, "ctrl+n")).state,
    ).toBe("rejected");
    expect(
      (await backend.writeAction(action, "user", baseline, "ctrl++")).state,
    ).toBe("rejected");
    expect(
      (await backend.writeAction(action, "user", baseline, "not-a-key")).state,
    ).toBe("rejected");
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...current,
        [action]: "alt+n",
        "app.future.external": ["f10"],
      }),
    );
    expect(
      (await backend.writeAction(action, "user", baseline, "ctrl+n")).state,
    ).toBe("rejected");
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved[action]).toBe("alt+n");
    expect(saved["app.future.external"]).toEqual(["f10"]);
  });
});
