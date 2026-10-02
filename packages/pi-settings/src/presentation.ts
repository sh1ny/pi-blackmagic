import type { SettingDescriptor } from "./contracts.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CenterBodyRow, CenterRow, CenterView } from "./ui-controller.ts";
import type { ViewportFrame } from "./viewport.ts";

const labels: Readonly<Record<string, string>> = {
  hideThinkingBlock: "Hide thinking blocks",
  showCacheMissNotices: "Cache miss notices",
  theme: "Theme",
  quietStartup: "Quiet startup",
  tuiMode: "Terminal mode",
  fullscreenExitOutput: "Output on exit",
  fullscreenScrollbar: "Scrollbar",
  fullscreenCopyOnSelect: "Copy on selection",
  fullscreenWheelScrollLines: "Wheel scroll lines",
  editorPaddingX: "Horizontal padding",
  outputPad: "Output spacing",
  autocompleteMaxVisible: "Autocomplete rows",
  showHardwareCursor: "Hardware cursor",
  defaultProvider: "Default provider",
  defaultModel: "Default model",
  defaultThinkingLevel: "Default thinking level",
  defaultProjectTrust: "Default project trust",
  httpProxy: "HTTP proxy",
};
export function readableLabel(label: string): string {
  return (
    labels[label] ??
    label
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/[._]/g, " ")
      .replace(/\b(ms)\b/gi, "(ms)")
      .replace(/^./, (letter) => letter.toUpperCase())
  );
}

/** Display categories only; no schema, scope, storage, or activation changes. */
export function sectionFor(descriptor: SettingDescriptor): string {
  if (descriptor.metadataSensitivity === "masked") return "Settings";
  const key = descriptor.path[0] ?? descriptor.label;
  if (descriptor.providerId === "native") {
    if (key === "theme") return "Theme";
    if (/^(editor|autocomplete|showHardwareCursor|externalEditor)/.test(key))
      return "Composer";
    if (/^(fullscreen|tuiMode|terminal)/.test(key)) return "Terminal";
    if (
      /^(hideThinking|showCache|quietStartup|outputPad|collapseChangelog)/.test(
        key,
      )
    )
      return "Display";
    if (key === "markdown") return "Markdown";
    if (/^(defaultProvider|defaultModel|enabledModels|transport)/.test(key))
      return "Models";
    if (/^(thinking|modelThinking|defaultThinking)/.test(key))
      return "Thinking";
    if (key === "retry") return "Retries";
    if (key === "images") return "Images";
    if (key === "cacheWarming") return "Caching";
    if (key === "compaction") return "Compaction";
    if (key === "branchSummary") return "Branch summaries";
    if (key === "sessionDir") return "Sessions";
    if (/^(shell|npmCommand)/.test(key)) return "Shell";
    if (
      /^(packages|extensions|skills|prompts|themes|enableSkillCommands)/.test(
        key,
      )
    )
      return "Resources";
    if (key === "codemode" || key === "defaultTools") return "Tool selection";
    if (/^(http|websocket)/.test(key)) return "Network";
    if (/^(enableInstallTelemetry|enableAnalytics|warnings)/.test(key))
      return "Privacy & notices";
    if (key === "defaultProjectTrust") return "Project trust";
    return "Interaction";
  }
  if (descriptor.pageId === "Keybindings") {
    const action = descriptor.path[0] ?? "";
    return action.startsWith("tui.") ? "Editor & selectors" : "Application";
  }
  if (descriptor.pageId === "MCP")
    return descriptor.path[0] === "autoEnableCodemode" ? "Defaults" : "Servers";
  if (descriptor.pageId === "Models") return "Providers";
  const source = descriptor.sourceLabel.split(" / ");
  return source[0] === "Extensions"
    ? source.slice(1).join(" / ") || "Extensions"
    : "Settings";
}

const sectionOrder = [
  "Theme",
  "Composer",
  "Display",
  "Terminal",
  "Markdown",
  "Models",
  "Thinking",
  "Retries",
  "Images",
  "Caching",
  "Compaction",
  "Branch summaries",
  "Sessions",
  "Tool selection",
  "Shell",
  "Resources",
  "Interaction",
  "Network",
  "Project trust",
  "Privacy & notices",
  "Defaults",
  "Servers",
  "Providers",
  "Application",
  "Editor & selectors",
];
/** Keep row identities intact and navigation in the same order as the grouped presentation. */
export function presentationRows(rows: readonly CenterRow[]): CenterRow[] {
  const rank = (row: CenterRow) => {
    const index = sectionOrder.indexOf(sectionFor(row.descriptor));
    return index < 0 ? sectionOrder.length : index;
  };
  return [...rows].sort((left, right) => rank(left) - rank(right));
}

function displayValue(row: CenterBodyRow): string {
  switch (row.readState) {
    case "loading":
      return "Loading…";
    case "unavailable":
      return "Unavailable";
    case "error":
      return "Read error";
    default:
      return row.value ?? "Not configured";
  }
}

export function presentationFrame(
  view: CenterView,
  descriptors: ReadonlyMap<string, SettingDescriptor>,
  keyHints: string,
): ViewportFrame {
  const editor = view.editor;
  if (editor) {
    const lines =
      editor.picking || editor.input === null
        ? editor.lines.map((line) => ({
            text: line.label,
            label: editor.picking ? line.label : readableLabel(line.label),
            value: line.description,
            group: editor.picking ? "Choose value" : "Edit entry",
          }))
        : [
            {
              text: `${editor.path.join(".") || "Value"}: ${editor.input}`,
              label: readableLabel(editor.path.join(".") || "Value"),
              value: editor.input,
              group: "Edit entry",
            },
          ];
    return {
      tabs: view.tabs,
      activeTab: view.tab,
      query: editor.picking ? (editor.input ?? "") : view.query,
      searchText: editor.picking
        ? `Filter choices: ${editor.input || "type to filter"}`
        : "Editing entry · global search paused",
      content: lines,
      selectedIndex:
        editor.picking || editor.input === null ? editor.selected : 0,
      help: [editor.help],
      status: editor.message || view.status.message,
      keyHints,
    };
  }
  const selected = view.body[view.selected ?? -1];
  const settings = view.body.filter((row) => row.kind === "setting");
  const content = settings.map((row) => {
    const descriptor = descriptors.get(row.descriptorId);
    const group = descriptor ? sectionFor(descriptor) : "Settings";
    const label =
      descriptor?.providerId === "native" &&
      descriptor.metadataSensitivity !== "masked" &&
      descriptor.path.length > 1
        ? readableLabel(descriptor.path.slice(1).join(" "))
        : readableLabel(row.label);
    return {
      text: `${label} = ${displayValue(row)}`,
      label,
      value: displayValue(row),
      group,
      ...(view.query ? { source: row.sourceLabel } : {}),
    };
  });
  const actions = view.body
    .filter(
      (row) =>
        row.descriptorId === selected?.descriptorId && row.kind !== "setting",
    )
    .map((row) => ({
      text:
        row.kind === "scope"
          ? `${row.scope === "user" ? "User" : "Project"}${row.label.includes("(selected)") ? " ✓" : ""}${row.supported ? "" : " (unavailable)"}`
          : row.kind === "reset"
            ? "Reset to inherited"
            : "Delete…",
      selected: row.selected,
      disabled: !row.supported,
    }));
  const setting = settings.find(
    (row) => row.descriptorId === selected?.descriptorId,
  );
  const summary = (value: string | null | undefined) =>
    truncateToWidth(value ?? "unknown", 18, "…");
  const details = setting
    ? `Scope: ${setting.scope} · Source: ${setting.provenance?.source ?? "unknown"} · Configured: ${setting.configured?.present ? summary(setting.configured.value) : "inherited"} · Effective: ${setting.effective?.known ? summary(setting.effective.value) : "unknown"} · Session: ${setting.provenance?.sessionState ?? "unknown"}`
    : undefined;
  const chosen = Math.max(
    0,
    settings.findIndex((row) => row.descriptorId === selected?.descriptorId),
  );
  return {
    tabs: view.tabs,
    activeTab: view.tab,
    query: view.query,
    content,
    selectedIndex: chosen,
    help: [view.help.split(" Scope:")[0] ?? view.help],
    ...(details ? { details } : {}),
    status: view.status.message,
    keyHints,
    actions,
    actionMode: view.navigationMode === "actions",
  };
}
