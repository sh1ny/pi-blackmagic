import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CenterRow } from "../src/ui-controller.ts";
import { SettingsCenterPanel } from "../src/panel.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as unknown as Theme;
const row: CenterRow = {
  descriptor: {
    id: "synthetic:general:toggle",
    providerId: "synthetic",
    pageId: "general",
    path: ["toggle"],
    label: "Synthetic toggle",
    description: "A synthetic boolean preference",
    sourceLabel: "General",
    schema: { kind: "boolean" },
    scopes: ["user"],
    sensitivity: "public",
    activation: "reload",
  },
  read: async (scope) => ({
    state: "available",
    scope,
    configured: { present: true, value: false },
    effective: { known: true, value: false },
    revision: "synthetic",
    provenance: { source: "user", sessionState: "unknown" },
  }),
  write: async () => ({ state: "failed", message: "Not used" }),
};

test("panel fills live viewport, resizes, routes navigation and restores via done once", async () => {
  let renders = 0;
  let closed = 0;
  const terminal = { rows: 24 };
  const tui = {
    terminal,
    requestRender: () => {
      renders++;
    },
  };
  const panel = new SettingsCenterPanel(
    [row],
    tui as ConstructorParameters<typeof SettingsCenterPanel>[1],
    () => theme,
    () => {
      closed++;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  for (const [width, height] of [
    [80, 24],
    [12, 8],
    [1, 2],
    [120, 40],
  ]) {
    terminal.rows = height as number;
    const lines = panel.render(width as number);
    expect(lines).toHaveLength(height as number);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  }
  panel.handleInput("\u001b[C");
  expect(panel.controller.view().tab).toBe("Appearance");
  panel.handleInput("synthetic");
  expect(panel.controller.view().query).toBe("synthetic");
  expect(panel.render(80).join("\n")).toContain("Synthetic toggle");
  panel.handleInput("\u001b");
  expect(panel.controller.view().query).toBe("");
  panel.handleInput("\u001b");
  expect(closed).toBe(1);
  panel.dispose();
  panel.dispose();
  panel.handleInput("x");
  panel.invalidate();
  expect(closed).toBe(1);
  expect(renders).toBeGreaterThan(0);
});
