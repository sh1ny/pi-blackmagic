import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ViewportContent {
  text: string;
  selected?: boolean;
  label?: string;
  value?: string;
  group?: string;
  source?: string;
}
export interface ViewportFrame {
  tabs: readonly string[];
  activeTab: string;
  query: string;
  searchText?: string;
  content: readonly ViewportContent[];
  selectedIndex: number;
  help: readonly string[];
  status: string;
  keyHints: string;
  details?: string;
  actionMode?: boolean;
  actions?: readonly { text: string; selected: boolean; disabled?: boolean }[];
}
export interface PanelTheme {
  style(
    text: string,
    options: {
      fg?: "accent" | "text" | "muted";
      bg: "customMessageBg" | "selectedBg";
      bold?: boolean;
    },
  ): string;
}
export function viewportLayout(height: number): {
  bodyHeight: number;
  compact: boolean;
} {
  const rows = Math.max(0, Math.floor(height));
  return rows >= 7
    ? { bodyHeight: rows - 6, compact: false }
    : { bodyHeight: Math.max(1, rows - 2), compact: true };
}
function fit(text: string, width: number): string {
  const columns = Math.max(0, width);
  const clipped = truncateToWidth(text.replace(/[\r\n]/g, " "), columns, "…");
  return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
}
/** Stateless, full-viewport application chrome. All input and persistence stay controller-owned. */
export function renderViewport(
  frame: ViewportFrame,
  width: number,
  height: number,
  theme: PanelTheme,
): string[] {
  const columns = Math.max(0, Math.floor(width));
  const rows = Math.max(0, Math.floor(height));
  if (!rows) return [];
  const style = (
    text: string,
    fg: "accent" | "text" | "muted" = "text",
    selected = false,
    bold = false,
  ) =>
    theme.style(text, {
      fg,
      bg: selected ? "selectedBg" : "customMessageBg",
      ...(bold ? { bold: true } : {}),
    });
  const paint = (
    text: string,
    fg: "accent" | "text" | "muted" = "text",
    selected = false,
  ) => style(fit(text, columns), fg, selected);
  const selectedIndex = Math.max(
    0,
    Math.min(frame.content.length - 1, frame.selectedIndex),
  );
  const selection = frame.content[selectedIndex];
  const selectedAction = frame.actions?.find((action) => action.selected);
  const selectedSummary = selectedAction
    ? `› ${selectedAction.text}`
    : (selection?.text ?? "No settings");
  const tabIndex = Math.max(0, frame.tabs.indexOf(frame.activeTab));
  const tabText = frame.tabs
    .map((tab) => `${tab === frame.activeTab ? "✓" : " "} ${tab} `)
    .join("  ");
  let firstTab = tabIndex;
  let lastTab = tabIndex;
  const windowText = () =>
    `${firstTab > 0 ? "‹ " : ""}${frame.tabs
      .slice(firstTab, lastTab + 1)
      .map((tab) => `${tab === frame.activeTab ? "✓" : " "} ${tab} `)
      .join("  ")}${lastTab < frame.tabs.length - 1 ? " ›" : ""}`;
  let expand = true;
  while (expand) {
    expand = false;
    if (firstTab > 0) {
      firstTab--;
      if (visibleWidth(windowText()) > Math.max(0, columns - 4)) firstTab++;
      else expand = true;
    }
    if (lastTab < frame.tabs.length - 1) {
      lastTab++;
      if (visibleWidth(windowText()) > Math.max(0, columns - 4)) lastTab--;
      else expand = true;
    }
  }
  const tabs =
    visibleWidth(tabText) <= Math.max(0, columns - 4) ? tabText : windowText();
  if (visibleWidth(tabText) <= Math.max(0, columns - 4)) {
    firstTab = 0;
    lastTab = frame.tabs.length - 1;
  }
  if (viewportLayout(rows).compact) {
    if (rows === 1)
      return [
        paint(
          `${selectedAction ? "Actions" : frame.activeTab}: ${selectedSummary} | ${frame.status}`,
          "accent",
          true,
        ),
      ];
    const lines = [
      paint(`${tabs}${frame.query ? ` / ${frame.query}` : ""}`, "accent"),
    ];
    const body = rows - 2;
    const start = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(body / 2),
        frame.content.length - body,
      ),
    );
    for (let index = 0; index < body; index++)
      lines.push(
        paint(
          frame.content[start + index]?.text ?? "",
          "text",
          start + index === selectedIndex,
        ),
      );
    lines.push(
      paint(
        `${rows === 2 || selectedAction ? `${selectedSummary} | ` : ""}${frame.status || frame.help.join(" ") || frame.keyHints}`,
        "muted",
      ),
    );
    return lines;
  }
  const framed = columns >= 8;
  const inner = Math.max(0, columns - (framed ? 4 : 0));
  const border = (text: string, fg: "accent" | "text" | "muted" = "muted") =>
    framed
      ? style("│ ", "muted") +
        style(fit(text, inner), fg) +
        style(" │", "muted")
      : paint(text, fg);
  const rule = (left: string, title: string, right: string) =>
    paint(
      `${left}${title}${"─".repeat(Math.max(0, columns - visibleWidth(title) - 2))}${right}`,
      "muted",
    );
  const result = [rule("┌", " Settings ", "┐")];
  if (framed && visibleWidth(tabs) <= inner) {
    const segments = frame.tabs
      .slice(firstTab, lastTab + 1)
      .map((tab) =>
        style(
          `${tab === frame.activeTab ? "✓" : " "} ${tab} `,
          tab === frame.activeTab ? "accent" : "muted",
          tab === frame.activeTab,
          tab === frame.activeTab,
        ),
      );
    const strip =
      style(firstTab > 0 ? "‹ " : "", "muted") +
      segments.join(style("  ", "muted")) +
      style(lastTab < frame.tabs.length - 1 ? " ›" : "", "muted");
    result.push(
      style("│ ", "muted") +
        strip +
        style(" ".repeat(Math.max(0, inner - visibleWidth(strip))), "muted") +
        style(" │", "muted"),
    );
  } else result.push(border(tabs, "accent"));
  result.push(
    border(
      frame.searchText ??
        (frame.query
          ? `Search all tabs: ${frame.query}`
          : "Type to search all tabs"),
      "muted",
    ),
  );

  const groups = [
    ...new Set(
      frame.content
        .map((entry) => entry.group)
        .filter((group): group is string => Boolean(group)),
    ),
  ];
  const activeGroup = selection?.group;
  const sidebar =
    columns >= 76 && groups.length > 0
      ? Math.min(24, Math.max(18, Math.floor(inner * 0.18)))
      : 0;
  const paneWidth = Math.max(0, inner - (sidebar ? sidebar + 3 : 0));
  const labelWidth = Math.min(38, Math.max(12, Math.floor(paneWidth * 0.48)));
  const lines: { text: string; selected: boolean; heading: boolean }[] = [];
  let lastGroup: string | undefined;
  let selectedLine = 0;
  frame.content.forEach((entry, index) => {
    if (entry.group && entry.group !== lastGroup) {
      lines.push({ text: entry.group, selected: false, heading: true });
      lastGroup = entry.group;
    }
    if (index === selectedIndex) selectedLine = lines.length;
    const value =
      entry.label === undefined
        ? entry.text
        : paneWidth >= 32
          ? `${fit(entry.label, labelWidth)}  ${entry.value ?? "—"}`
          : `${entry.label}: ${entry.value ?? "—"}`;
    const source = entry.source ? `${entry.source} / ` : "";
    lines.push({
      text: `${source}${value}`,
      selected: index === selectedIndex,
      heading: false,
    });
  });
  if (!lines.length)
    lines.push({
      text: "No matching settings",
      selected: false,
      heading: false,
    });
  const showDetails =
    Boolean(frame.details) && viewportLayout(rows).bodyHeight >= 3;
  const bodyHeight = viewportLayout(rows).bodyHeight - (showDetails ? 1 : 0);
  const hasActions =
    Boolean(frame.actions?.length) &&
    (bodyHeight >= 2 || Boolean(selectedAction));
  const listHeight = bodyHeight - (hasActions ? 1 : 0);
  const start = Math.max(
    0,
    Math.min(
      selectedLine - Math.floor(listHeight / 2),
      lines.length - listHeight,
    ),
  );
  const sidebarStart = Math.max(
    0,
    Math.min(
      groups.indexOf(activeGroup ?? "") - Math.floor(listHeight / 2),
      groups.length - listHeight,
    ),
  );
  for (let offset = 0; offset < listHeight; offset++) {
    const line = lines[start + offset];
    let middle = "";
    if (sidebar) {
      const group = groups[sidebarStart + offset];
      middle =
        style(
          fit(group ?? "", sidebar),
          group === activeGroup ? "accent" : "muted",
          false,
          group === activeGroup,
        ) + style(" │ ", "muted");
    }
    const text = line
      ? `${line.heading ? "  " : line.selected ? "› " : "  "}${line.text}`
      : "";
    middle += style(
      fit(text, paneWidth),
      line?.selected ? "accent" : line?.heading ? "muted" : "text",
      line?.selected ?? false,
      line?.heading ?? false,
    );
    const thumbSize = Math.max(
      1,
      Math.floor((listHeight * listHeight) / lines.length),
    );
    const thumbStart =
      lines.length > listHeight
        ? Math.floor(
            (start / (lines.length - listHeight)) * (listHeight - thumbSize),
          )
        : -1;
    const scrollAccent =
      thumbStart >= 0 &&
      offset >= thumbStart &&
      offset < thumbStart + thumbSize;
    result.push(
      framed
        ? style("│ ", "muted") +
            middle +
            style(" │", scrollAccent ? "accent" : "muted")
        : paint(text, line?.selected ? "accent" : "text", line?.selected),
    );
  }
  if (hasActions) {
    const actionText = (frame.actions ?? [])
      .map(
        (action) =>
          `${action.selected ? "› [" : ""}${action.text}${action.selected ? "]" : ""}`,
      )
      .join("   ·   ");
    const activeAction = frame.actions?.find((action) => action.selected);
    const strip = `${frame.actionMode ? "Actions ↑/↓" : "Tab → actions"}: ${actionText}`;
    result.push(
      border(
        visibleWidth(strip) > inner && activeAction
          ? `› ${activeAction.text}`
          : strip,
        "accent",
      ),
    );
  }
  if (showDetails) result.push(border(frame.details ?? "", "muted"));
  result.push(
    border(frame.help.join(" | "), "muted"),
    border(frame.status, "text"),
    rule("└", ` ${frame.keyHints} `, "┘"),
  );
  return result;
}
