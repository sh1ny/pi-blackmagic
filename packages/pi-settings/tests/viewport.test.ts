import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderViewport, viewportLayout } from "../src/viewport.ts";
import type { PanelTheme, ViewportFrame } from "../src/viewport.ts";

const theme: PanelTheme = {
  style: (text, options) =>
    `\u001b[48;5;${options.bg === "selectedBg" ? 24 : 16}m${text}\u001b[0m`,
};
const frame: ViewportFrame = {
  tabs: [
    "General",
    "Appearance",
    "Models",
    "Context",
    "Tools",
    "Keybindings",
    "MCP",
    "Extensions",
  ],
  activeTab: "Extensions",
  query: "",
  content: Array.from({ length: 100 }, (_, index) => ({
    text: `row-${index} 中文 界 🧙 \u001b[31mANSI\u001b[0m`,
  })),
  selectedIndex: 90,
  help: ["Selected setting description", "Scope: user"],
  status: "Saved; explicit reload required",
  keyHints: "←/→ tabs · ↑/↓ rows · Enter edit · Esc close",
};

test("full viewport is exactly terminal height with opaque padding at every width", () => {
  for (const width of [0, 1, 2, 8, 20, 80, 160])
    for (const height of [0, 1, 2, 3, 6, 7, 24, 80]) {
      const lines = renderViewport(frame, width, height, theme);
      expect(lines.length).toBe(height);
      for (const line of lines) {
        expect(visibleWidth(line)).toBe(width);
        expect(line).toContain("\u001b[48;5;");
      }
    }
});

test("long-page selection remains in bounded body and help/status/hints are reserved", () => {
  const lines = renderViewport(frame, 120, 24, theme);
  expect(lines.some((line) => line.includes("row-90"))).toBe(true);
  expect(lines.slice(-3).join("\n")).toContain("Selected setting description");
  expect(lines.slice(-3).join("\n")).toContain("Scope: user");
  expect(lines.slice(-3).join("\n")).toContain("explicit reload required");
  expect(lines.slice(-3).join("\n")).toContain("Enter edit");
  expect(lines.some((line) => line.includes("row-0 "))).toBe(false);
});

test("narrow tabs retain active indication, query remains global, and short view keeps selection reachable", () => {
  const lines = renderViewport({ ...frame, query: "synthetic" }, 25, 8, theme);
  expect(lines[1]).toContain("Extensions");
  expect(lines[2]).toContain("Search all tabs");
  const compact = renderViewport(frame, 80, 2, theme);
  expect(compact[1]).toContain("row-90");
  expect(viewportLayout(2).compact).toBe(true);
});

test("selected actions remain identifiable in every short viewport", () => {
  const actionFrame: ViewportFrame = {
    ...frame,
    actionMode: true,
    actions: [
      { text: "User", selected: false },
      { text: "Reset to inherited", selected: true },
    ],
  };
  for (const height of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const lines = renderViewport(actionFrame, 80, height, theme);
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(lines.join("\n")).toContain("Reset to inherited");
  }
});

test("resize and theme invalidation recompute without stale colors or overflow", () => {
  let color = 16;
  const changing: PanelTheme = {
    style: (text) => `\u001b[48;5;${color}m${text}\u001b[0m`,
  };
  const before = renderViewport(frame, 80, 24, changing);
  color = 17;
  const after = renderViewport(frame, 13, 7, changing);
  expect(before[0]).toContain("48;5;16");
  expect(
    after.every(
      (line) => line.includes("48;5;17") && !line.includes("48;5;16"),
    ),
  ).toBe(true);
  expect(after.every((line) => visibleWidth(line) === 13)).toBe(true);
});
