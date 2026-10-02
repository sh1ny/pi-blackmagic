import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SettingDescriptor } from "../src/contracts.ts";
import {
  presentationFrame,
  presentationRows,
  readableLabel,
} from "../src/presentation.ts";
import {
  SettingsCenterController,
  type CenterRow,
} from "../src/ui-controller.ts";
import { renderViewport, type PanelTheme } from "../src/viewport.ts";

const theme: PanelTheme = { style: (text) => text };
function row(path: string, value: boolean | string = false): CenterRow {
  const descriptor: SettingDescriptor = {
    id: `native.${path}`,
    providerId: "native",
    pageId: "Appearance",
    path: path.split("."),
    label: path,
    description: "Synthetic public setting description",
    sourceLabel: "Appearance",
    schema: typeof value === "boolean" ? { kind: "boolean" } : { kind: "text" },
    scopes: ["user", "project"],
    sensitivity: "public",
    activation: "reload",
  };
  return {
    descriptor,
    read: async (scope) => ({
      state: "available",
      scope,
      configured: { present: true, value },
      effective: { known: true, value },
      revision: "synthetic",
      provenance: { source: scope, sessionState: "unknown" },
    }),
    write: async () => {
      throw new Error("Presentation must not write");
    },
    removeOverride: async () => {
      throw new Error("Presentation must not reset");
    },
  };
}

test("searchable pickers render choice rows, keep selection visible and never search the background catalog", async () => {
  const model = row("defaultModel", "model-42");
  model.editorSuggestions = async () => () =>
    Array.from({ length: 100 }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
      description: `provider/model-${index}`,
    }));
  const controller = new SettingsCenterController([model], {
    tabs: ["Appearance"],
    onChange: () => {},
    onClose: () => {},
  });
  const descriptors = new Map([[model.descriptor.id, model.descriptor]]);
  try {
    controller.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    let frame = presentationFrame(
      controller.view(),
      descriptors,
      "Picker controls",
    );
    expect(frame.content).toHaveLength(101);
    expect(frame.selectedIndex).toBe(42);
    for (const height of [1, 2, 4, 8, 24]) {
      const screen = renderViewport(frame, 100, height, theme);
      expect(screen).toHaveLength(height);
      expect(screen.join("\n")).toContain("Model 42");
      expect(screen.every((line) => visibleWidth(line) === 100)).toBe(true);
    }
    controller.handleInput("Model 99");
    expect(controller.view().query).toBe("");
    frame = presentationFrame(
      controller.view(),
      descriptors,
      "Picker controls",
    );
    expect(frame.content.map((line) => line.label)).toContain("Model 99");
    expect(frame.content.map((line) => line.label)).not.toContain("Model 42");
    expect(renderViewport(frame, 100, 24, theme).join("\n")).toContain(
      "Filter choices: Model 99",
    );
    controller.handleInput("\t");
    frame = presentationFrame(
      controller.view(),
      descriptors,
      "Custom controls",
    );
    expect(frame.content).toHaveLength(1);
    expect(frame.content[0]?.value).toBe("model-42");
    controller.handleInput("\x1b");
  } finally {
    controller.dispose();
  }
});

test("presentation groups stable row identities and humanizes labels without changing descriptors", () => {
  const display = row("hideThinkingBlock");
  const terminal = row("fullscreenScrollbar");
  const themed = row("theme", "system");
  const composer = row("editorPaddingX");
  const original = [display, terminal, themed, composer];
  expect(presentationRows(original)).toEqual([
    themed,
    composer,
    display,
    terminal,
  ]);
  expect(original).toEqual([display, terminal, themed, composer]);
  expect(themed.descriptor.label).toBe("theme");
  expect(readableLabel("hideThinkingBlock")).toBe("Hide thinking blocks");
  expect(readableLabel("websocketConnectTimeoutMs")).toBe(
    "Websocket Connect Timeout (ms)",
  );
});

test("scope/reset actions render once in a contextual strip, retaining existing controller navigation", async () => {
  const rows = presentationRows([
    row("hideThinkingBlock"),
    row("theme", "system"),
    row("fullscreenScrollbar"),
  ]);
  const descriptors = new Map(
    rows.map((entry) => [entry.descriptor.id, entry.descriptor]),
  );
  const controller = new SettingsCenterController(rows, {
    onChange: () => {},
    onClose: () => {},
  });
  controller.handleInput("\u001b[C"); // Appearance
  await new Promise((resolve) => setTimeout(resolve, 0));
  let frame = presentationFrame(
    controller.view(),
    descriptors,
    "←/→ tabs · Enter edit · Esc close",
  );
  expect(frame.content).toHaveLength(3);
  expect(frame.content.map((entry) => entry.group)).toEqual([
    "Theme",
    "Display",
    "Terminal",
  ]);
  expect(frame.actions?.map((action) => action.text)).toEqual([
    "User ✓",
    "Project",
    "Reset to inherited",
  ]);
  const screen = renderViewport(frame, 100, 24, theme).join("\n");
  expect(screen.match(/Reset to inherited/g)).toHaveLength(1);
  expect(screen).not.toContain("hideThinkingBlock");
  expect(screen).toContain("Hide thinking blocks");
  expect(screen).toContain("✓ Appearance");
  expect(screen).toContain("Synthetic public setting description");
  expect(frame.content.map((entry) => entry.value)).toEqual([
    '"system"',
    "false",
    "false",
  ]);
  controller.handleInput("\u001b[B");
  expect(
    presentationFrame(controller.view(), descriptors, "Enter edit")
      .selectedIndex,
  ).toBe(1);
  controller.handleInput("\u001b[A");
  expect(
    presentationFrame(controller.view(), descriptors, "Enter edit")
      .selectedIndex,
  ).toBe(0);
  controller.handleInput("\t"); // Explicit actions mode, not a mutation.
  frame = presentationFrame(controller.view(), descriptors, "Enter action");
  expect(frame.selectedIndex).toBe(0);
  expect(frame.actions?.[0]?.selected).toBe(true);
  expect(renderViewport(frame, 100, 24, theme).join("\n")).toContain(
    "› [User ✓]",
  );
  controller.handleInput("\u001b[B");
  controller.handleInput("\u001b[B"); // Reset remains visibly selected on narrow terminals.
  frame = presentationFrame(controller.view(), descriptors, "Enter action");
  expect(renderViewport(frame, 25, 14, theme).join("\n")).toContain(
    "Reset to inherited",
  );
  controller.handleInput("theme");
  frame = presentationFrame(controller.view(), descriptors, "Enter edit");
  expect(frame.content[0]?.source).toBe("Appearance");
  controller.dispose();
});

test("value-state presentation distinguishes background loading and safe read failures", () => {
  const rows = [
    row("theme", "system"),
    row("hideThinkingBlock"),
    row("fullscreenScrollbar"),
  ];
  const descriptors = new Map(
    rows.map((entry) => [entry.descriptor.id, entry.descriptor]),
  );
  const controller = new SettingsCenterController(rows, {
    onChange: () => {},
    onClose: () => {},
  });
  controller.handleInput("\u001b[C");
  const view = controller.view();
  const states = new Map<string, "loading" | "unavailable" | "error">([
    ["native.theme", "loading"],
    ["native.hideThinkingBlock", "unavailable"],
    ["native.fullscreenScrollbar", "error"],
  ]);
  const frame = presentationFrame(
    {
      ...view,
      body: view.body.map((entry) => ({
        ...entry,
        value: "synthetic-untrusted-error-text",
        readState: states.get(entry.descriptorId) ?? "loading",
      })),
    },
    descriptors,
    "Enter edit",
  );
  expect(frame.content.map((entry) => entry.value)).toEqual([
    "Loading…",
    "Unavailable",
    "Read error",
  ]);
  expect(JSON.stringify(frame)).not.toContain("synthetic-untrusted-error-text");
  controller.dispose();
});

test("grouped layout aligns values, has a passive sidebar, and remains bounded on resize", () => {
  const frame = {
    tabs: ["General", "Appearance"],
    activeTab: "Appearance",
    query: "",
    content: [
      {
        text: "Theme: system",
        label: "Theme",
        value: "system",
        group: "Theme",
      },
      {
        text: "Color capability: auto",
        label: "Color capability",
        value: "auto",
        group: "Theme",
      },
      {
        text: "Images: false",
        label: "Show images",
        value: "false",
        group: "Images",
      },
    ],
    selectedIndex: 0,
    help: ["Selected setting description"],
    status: "Saved; reload required",
    keyHints: "Enter edit · Esc close",
  };
  const wide = renderViewport(frame, 110, 22, theme);
  expect(wide[0]).toContain("┌ Settings");
  expect(
    wide.some((line) => line.includes("│ Theme") && line.includes("│")),
  ).toBe(true);
  const first = wide.find((line) => line.includes("system"));
  const second = wide.find((line) => line.includes("auto"));
  expect(first?.indexOf("system")).toBe(second?.indexOf("auto"));
  for (const width of [0, 1, 8, 25, 60, 76, 110]) {
    for (const height of [1, 2, 6, 7, 12, 30]) {
      const lines = renderViewport(frame, width, height, theme);
      expect(lines).toHaveLength(height);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    }
  }
});

test("metadata-masked entries never recover private labels through the display transform", () => {
  const privateRow = row("privateSecret.label");
  privateRow.descriptor.metadataSensitivity = "masked";
  const controller = new SettingsCenterController([privateRow], {
    onChange: () => {},
    onClose: () => {},
  });
  controller.handleInput("\u001b[C");
  const frame = presentationFrame(
    controller.view(),
    new Map([[privateRow.descriptor.id, privateRow.descriptor]]),
    "Enter edit",
  );
  expect(JSON.stringify(frame)).not.toContain("privateSecret");
  expect(frame.content[0]?.label).toBe("Private setting");
  controller.dispose();
});
