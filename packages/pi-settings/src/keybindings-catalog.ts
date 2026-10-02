import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { JsonValue, SettingDescriptor } from "./contracts.ts";

interface Action {
  description: string;
  defaultKeys: string | readonly string[];
}

/** Reviewed app actions; TUI actions come from the declared, baseline-compatible host peer. */
export function keybindingCatalog(
  platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, Action> {
  const windows =
    platform === "win32" ||
    (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
  const actions: Record<string, Action> = { ...TUI_KEYBINDINGS };
  const add = (
    id: string,
    defaultKeys: string | readonly string[],
    description: string,
  ) => {
    actions[id] = { defaultKeys, description };
  };
  add(
    "tui.editor.undo",
    platform === "win32" ? "ctrl+z" : windows ? "alt+z" : "ctrl+-",
    "Undo editor input",
  );
  add(
    "tui.altScreen.previousPrompt",
    windows ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
    "Previous transcript prompt",
  );
  add(
    "tui.altScreen.nextPrompt",
    windows ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
    "Next transcript prompt",
  );
  add(
    "tui.altScreen.search",
    windows ? "ctrl+f" : "ctrl+shift+f",
    "Search transcript",
  );
  const common: [string, string | readonly string[], string][] = [
    ["app.interrupt", "escape", "Cancel or abort"],
    ["app.clear", "ctrl+c", "Clear editor"],
    ["app.exit", "ctrl+d", "Exit when editor is empty"],
    [
      "app.suspend",
      platform === "win32" ? [] : "ctrl+z",
      "Suspend to background",
    ],
    ["app.thinking.cycle", "shift+tab", "Cycle thinking level"],
    ["app.thinking.save", "ctrl+s", "Save thinking level"],
    ["app.model.cycleForward", "ctrl+p", "Cycle to next model"],
    [
      "app.model.cycleBackward",
      windows ? "alt+p" : "shift+ctrl+p",
      "Cycle to previous model",
    ],
    ["app.model.select", "ctrl+l", "Open model selector"],
    ["app.tools.expand", "ctrl+o", "Toggle tool output"],
    ["app.thinking.toggle", "ctrl+t", "Toggle thinking blocks"],
    ["app.session.toggleNamedFilter", "ctrl+n", "Toggle named session filter"],
    ["app.editor.external", "ctrl+g", "Open external editor"],
    ["app.message.copy", "ctrl+x", "Copy selection or last assistant message"],
    [
      "app.message.followUp",
      windows ? "ctrl+q" : "alt+enter",
      "Queue follow-up message",
    ],
    [
      "app.message.dequeue",
      windows ? "alt+q" : "alt+up",
      "Restore queued messages",
    ],
    [
      "app.clipboard.pasteImage",
      windows ? "alt+v" : "ctrl+v",
      "Paste files, images, or text",
    ],
    ["app.session.new", [], "Start a new session"],
    ["app.session.tree", [], "Open session tree"],
    ["app.session.fork", [], "Fork current session"],
    ["app.session.resume", [], "Resume a session"],
    [
      "app.tree.foldOrUp",
      platform === "darwin"
        ? ["alt+left", "ctrl+left"]
        : ["ctrl+left", "alt+left"],
      "Fold tree branch or move up",
    ],
    [
      "app.tree.unfoldOrDown",
      platform === "darwin"
        ? ["alt+right", "ctrl+right"]
        : ["ctrl+right", "alt+right"],
      "Unfold tree branch or move down",
    ],
    ["app.tree.editLabel", "shift+l", "Edit tree label"],
    [
      "app.tree.toggleLabelTimestamp",
      "shift+t",
      "Toggle tree label timestamps",
    ],
    ["app.session.togglePath", "ctrl+p", "Toggle session path display"],
    ["app.session.toggleSort", "ctrl+s", "Toggle session sort mode"],
    ["app.session.rename", "ctrl+r", "Rename session"],
    ["app.session.delete", "ctrl+d", "Delete session"],
    [
      "app.session.deleteNoninvasive",
      "ctrl+backspace",
      "Delete session when query is empty",
    ],
    ["app.models.save", "ctrl+s", "Save model selection"],
    ["app.models.enableAll", "ctrl+a", "Enable all models"],
    ["app.models.clearAll", "ctrl+x", "Clear all models"],
    ["app.models.toggleProvider", "ctrl+p", "Toggle all models for provider"],
    ["app.models.reorderUp", "alt+up", "Move model up in order"],
    ["app.models.reorderDown", "alt+down", "Move model down in order"],
    ["app.tree.filter.default", "ctrl+d", "Tree filter: default view"],
    ["app.tree.filter.noTools", "ctrl+t", "Tree filter: hide tool results"],
    ["app.tree.filter.userOnly", "ctrl+u", "Tree filter: user messages only"],
    ["app.tree.filter.labeledOnly", "ctrl+l", "Tree filter: labelled entries"],
    ["app.tree.filter.all", "ctrl+a", "Tree filter: all entries"],
    ["app.tree.filter.cycleForward", "ctrl+o", "Tree filter: cycle forward"],
    [
      "app.tree.filter.cycleBackward",
      "shift+ctrl+o",
      "Tree filter: cycle backward",
    ],
  ];
  for (const [id, keys, description] of common) add(id, keys, description);
  return actions;
}

export const KEYBINDING_ACTIONS = keybindingCatalog();
export const KEYBINDING_DESCRIPTORS: readonly SettingDescriptor[] =
  Object.entries(KEYBINDING_ACTIONS).map(([id, action]) => ({
    id: `keybindings.${id}`,
    providerId: "keybindings",
    pageId: "Keybindings",
    path: [id],
    label: id,
    description: action.description,
    sourceLabel: "Keybindings",
    schema: {
      kind: "union",
      variants: [{ kind: "text" }, { kind: "list", item: { kind: "text" } }],
    },
    scopes: ["user"],
    sensitivity: "public",
    activation: "reload",
  }));
export function defaultAssignments(action: string): JsonValue {
  const keys = KEYBINDING_ACTIONS[action]?.defaultKeys ?? [];
  return typeof keys === "string" ? keys : [...keys];
}
