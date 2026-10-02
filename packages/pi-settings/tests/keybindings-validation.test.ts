import { expect, test } from "bun:test";
import { Key, matchesKey, parseKey } from "@earendil-works/pi-tui";
import {
  assignmentWarnings,
  captureKey,
  validateAssignments,
  validateKey,
} from "../src/keybindings-validation.ts";

test("baseline key grammar accepts supported names/modifiers and rejects malformed syntax", () => {
  for (const key of [
    "a",
    "0",
    "escape",
    "esc",
    "return",
    "pageUp",
    "f12",
    "ctrl+-",
    "ctrl+shift+alt+x",
    "alt+ctrl+x",
    "super+k",
    "ctrl+super+k",
    "ctrl+[",
  ])
    expect(validateKey(key).valid).toBe(true);
  for (const key of [
    "",
    "ctrl+",
    "ctrl+ctrl+a",
    "meta+a",
    "f13",
    "ctrl+unknown",
    "control+a",
    "a+b",
    " ctrl+a",
  ])
    expect(validateKey(key).valid).toBe(false);
  expect(validateAssignments("ctrl+a").valid).toBe(true);
  expect(validateAssignments(["ctrl+a", "alt+a"]).valid).toBe(true);
  expect(validateAssignments([]).valid).toBe(true);
  expect(validateAssignments(["ctrl+a", 3]).valid).toBe(false);
});

test("key capture uses the public host parser and reports unsupported input", () => {
  expect(captureKey("\u0001")).toEqual({ state: "captured", key: "ctrl+a" });
  expect(captureKey("\u001b[A")).toEqual({ state: "captured", key: "up" });
  expect(captureKey("\u001b[not-a-key").state).toBe("invalid");
});

test("documented baseline plus matcher discrepancy gets an explicit compatibility rejection", () => {
  expect(Key.plus).toBe("+");
  expect(parseKey("+")).toBe("+");
  expect(matchesKey("+", Key.plus)).toBe(false);
  expect(parseKey("\u001b[43;5u")).toBe("ctrl++");
  expect(matchesKey("\u001b[43;5u", Key.ctrl(Key.plus))).toBe(false);
  for (const key of ["+", "ctrl++", "alt+shift++"]) {
    const result = validateKey(key);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message).toContain("Pi 0.99.1");
  }
});

test("conflicts normalize aliases/modifier order and warn rather than reject contextual overlap", () => {
  const warnings = assignmentWarnings(
    "tui.editor.cursorUp",
    ["alt+ctrl+a", "esc"],
    {
      "tui.editor.cursorDown": "ctrl+alt+a",
      "tui.select.cancel": "escape",
      "app.clear": "ctrl+c",
    },
  );
  expect(warnings.map((warning) => warning.overlap)).toEqual([
    "same-context",
    "context-dependent",
  ]);
  expect(warnings[1]?.message).toContain("may be legitimate");
  expect(validateAssignments(["alt+ctrl+a", "esc"]).valid).toBe(true);
});
