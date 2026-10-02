import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsBackend } from "../src/keybindings-backend.ts";
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_DESCRIPTORS,
  keybindingCatalog,
} from "../src/keybindings-catalog.ts";
import fixture from "./fixtures/pi-0.99.1-coverage.json";
import future from "./fixtures/unknown-future-fields.json";

test("all reviewed host actions have descriptors and user-only scope", () => {
  expect(Object.keys(KEYBINDING_ACTIONS).sort()).toEqual(fixture.keybindings);
  expect(
    KEYBINDING_DESCRIPTORS.map(
      (descriptor) => descriptor.path[0],
    ).sort() as string[],
  ).toEqual(fixture.keybindings);
  for (const descriptor of KEYBINDING_DESCRIPTORS) {
    expect(descriptor.scopes).toEqual(["user"]);
    expect(descriptor.description.length).toBeGreaterThan(0);
  }
});

test("platform catalog matches native Windows, WSL, macOS and other host defaults", () => {
  expect(keybindingCatalog("win32", {})["tui.editor.undo"]?.defaultKeys).toBe(
    "ctrl+z",
  );
  expect(keybindingCatalog("win32", {})["app.suspend"]?.defaultKeys).toEqual(
    [],
  );
  expect(
    keybindingCatalog("linux", { WSL_DISTRO_NAME: "synthetic" })[
      "tui.editor.undo"
    ]?.defaultKeys,
  ).toBe("alt+z");
  expect(keybindingCatalog("linux", {})["tui.editor.undo"]?.defaultKeys).toBe(
    "ctrl+-",
  );
  expect(
    keybindingCatalog("darwin", {})["app.tree.foldOrUp"]?.defaultKeys,
  ).toEqual(["alt+left", "ctrl+left"]);
});

test("effective injected host assignments are distinct from saved defaults and future actions survive reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-keys-"));
  try {
    const path = join(directory, "keybindings.json");
    const content = JSON.stringify({
      ...future.keybindings,
      "app.session.new": "ctrl+n",
    });
    await writeFile(path, content);
    const backend = new KeybindingsBackend(
      { cwd: directory, isProjectTrusted: () => false },
      { getEffectiveConfig: () => ({ "app.session.new": ["ctrl+shift+n"] }) },
      () => directory,
    );
    const read = await backend.readAction("app.session.new");
    if (read.state !== "available") throw new Error("Missing assignments");
    expect(read.configured).toEqual({ present: true, value: "ctrl+n" });
    expect(read.effective).toEqual({ known: true, value: ["ctrl+shift+n"] });
    expect(read.provenance).toEqual({
      source: "host-override",
      sessionState: "known",
    });
    expect((await backend.readAction("app.session.new", "project")).state).toBe(
      "unavailable",
    );
    expect(await readFile(path, "utf8")).toBe(content);
    expect((await backend.readAction("app.future.action")).state).toBe(
      "unavailable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
