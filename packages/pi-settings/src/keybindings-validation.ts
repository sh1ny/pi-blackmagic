import { Key, parseKey } from "@earendil-works/pi-tui";
import type { JsonValue, ValidationResult } from "./contracts.ts";

const bases = new Set(
  Object.values(Key).flatMap((value) =>
    typeof value === "string" ? [value.toLowerCase()] : [],
  ),
);
for (const character of "abcdefghijklmnopqrstuvwxyz0123456789")
  bases.add(character);
const modifiers = ["ctrl", "alt", "shift", "super"];

export function validateKey(key: string): ValidationResult {
  if (key === "+" || key.endsWith("++"))
    return {
      valid: false,
      message:
        "Pi 0.99.1 captures plus-key assignments but cannot match them. Choose another key; existing stored assignments are retained.",
    };
  const parts = key.toLowerCase().split("+");
  const base = parts.pop();
  if (
    !base ||
    !bases.has(base) ||
    parts.some((part) => !modifiers.includes(part)) ||
    new Set(parts).size !== parts.length
  )
    return { valid: false, message: "Invalid Pi key syntax." };
  return { valid: true };
}

export function validateAssignments(value: JsonValue): ValidationResult {
  if (typeof value === "string") return validateKey(value);
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    for (const entry of value) {
      const result = validateKey(entry as string);
      if (!result.valid) return result;
    }
    return { valid: true };
  }
  return {
    valid: false,
    message:
      "Assign one key, a list of keys, or an empty list to disable the action.",
  };
}

export function captureKey(
  data: string,
): { state: "captured"; key: string } | { state: "invalid"; message: string } {
  const key = parseKey(data);
  if (!key)
    return {
      state: "invalid",
      message: "This terminal input is not a supported key.",
    };
  const result = validateKey(key);
  return result.valid
    ? { state: "captured", key }
    : { state: "invalid", message: result.message };
}

function normalized(key: string): string {
  const parts = key.toLowerCase().split("+");
  let base = parts.pop() ?? "";
  if (base === "esc") base = "escape";
  if (base === "return") base = "enter";
  return [
    ...modifiers.filter((modifier) => parts.includes(modifier)),
    base,
  ].join("+");
}
function list(value: JsonValue): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
}
function context(action: string): string {
  if (action.startsWith("tui.editor.") || action.startsWith("tui.input."))
    return "editor";
  if (action.startsWith("tui.altScreen.")) return "fullscreen";
  if (action.startsWith("app.tree.")) return "tree";
  if (action.startsWith("app.models.")) return "models-selector";
  if (action.startsWith("app.session.")) return "sessions";
  if (action.startsWith("tui.select.")) return "selector";
  return "application";
}
export interface ConflictWarning {
  otherAction: string;
  keys: string[];
  overlap: "same-context" | "context-dependent";
  message: string;
}
export function assignmentWarnings(
  action: string,
  proposed: JsonValue,
  assignments: Record<string, JsonValue>,
): ConflictWarning[] {
  const keys = new Set(list(proposed).map(normalized));
  const warnings: ConflictWarning[] = [];
  for (const [otherAction, value] of Object.entries(assignments)) {
    if (otherAction === action) continue;
    const shared = list(value)
      .map(normalized)
      .filter((key) => keys.has(key));
    if (shared.length === 0) continue;
    const overlap =
      context(action) === context(otherAction)
        ? "same-context"
        : "context-dependent";
    warnings.push({
      otherAction,
      keys: [...new Set(shared)],
      overlap,
      message:
        overlap === "same-context"
          ? "Potential overlapping assignment in the same host context; review before using it."
          : "Shared key across host contexts may be legitimate; this warning does not reject the assignment.",
    });
  }
  return warnings;
}
