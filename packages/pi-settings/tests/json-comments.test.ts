import { expect, test } from "bun:test";
import { stripJsonComments } from "../src/json-comments.ts";
import { validateValue } from "../src/validation.ts";

test("JSON comment stripping retains credential literals, URL text, escapes, and newlines", () => {
  const text =
    '{// synthetic comment\n"url":"https://example.invalid/*literal*/",/* block\ncomment */"key":"!synthetic-command\\"//literal"}';
  expect(JSON.parse(stripJsonComments(text))).toEqual({
    url: "https://example.invalid/*literal*/",
    key: '!synthetic-command"//literal',
  });
  expect(stripJsonComments(text).split("\n").length).toBe(
    text.split("\n").length,
  );
  expect(() => stripJsonComments('{"key":true/* unterminated')).toThrow(
    "Unterminated",
  );
});

test("structured validation supports JSON metadata, exclusive numeric limits, and array bounds", () => {
  expect(
    validateValue({ kind: "json" }, { metadata: [null, true, "literal"] })
      .valid,
  ).toBe(true);
  expect(validateValue({ kind: "json" }, Number.POSITIVE_INFINITY).valid).toBe(
    false,
  );
  expect(validateValue({ kind: "number", exclusiveMinimum: 0 }, 0).valid).toBe(
    false,
  );
  expect(validateValue({ kind: "number", exclusiveMinimum: 0 }, 1).valid).toBe(
    true,
  );
  expect(
    validateValue(
      { kind: "list", item: { kind: "text" }, minItems: 1, maxItems: 2 },
      [],
    ).valid,
  ).toBe(false);
  expect(
    validateValue(
      { kind: "list", item: { kind: "text" }, minItems: 1, maxItems: 2 },
      ["one", "two", "three"],
    ).valid,
  ).toBe(false);
});
