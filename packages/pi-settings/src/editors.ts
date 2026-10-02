import {
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { JsonValue, Sensitivity, ValueSchema } from "./contracts.ts";
import { captureKey } from "./keybindings-validation.ts";
import { isMasked, maskValue, safeDisplay } from "./redaction.ts";
import { validateValue } from "./validation.ts";

export type EditorOutcome =
  | { state: "editing" }
  | { state: "cancelled" }
  | { state: "complete"; value: JsonValue };

export interface EditorSuggestion {
  value: string;
  label: string;
  description?: string;
}
export interface EditorSuggestionContext {
  path: readonly string[];
  rootValue: JsonValue;
  parentValue: JsonValue | null;
  currentValue: JsonValue;
}
export type EditorSuggestions = (
  context: EditorSuggestionContext,
) => readonly EditorSuggestion[] | undefined;

export interface EditorLine {
  label: string;
  description: string;
  action: string;
  selected: boolean;
}
export interface EditorView {
  kind: ValueSchema["kind"] | "keybinding";
  path: readonly string[];
  lines: readonly EditorLine[];
  selected: number;
  input: string | null;
  cursor: number;
  message: string;
  help: string;
  /** A text filter owns input while selectable suggestion rows remain visible. */
  picking?: boolean;
}
interface Frame {
  schema: ValueSchema;
  value: JsonValue;
  original: JsonValue;
  sensitivity: Sensitivity;
  path: string[];
  selected: number;
  buffer: string;
  cursor: number;
  touched: boolean;
  sensitiveValues: Set<JsonValue>;
  draftKey?: string | null;
  picker?: {
    choices: readonly EditorSuggestion[];
    mode: "picker" | "custom";
    filter: string;
    cursor: number;
  };
  commit?: (value: JsonValue) => void;
}
interface Action {
  label: string;
  description: string;
  action: string;
  run: () => EditorOutcome;
}
const editing: EditorOutcome = { state: "editing" };

/** Printable input only, never escape sequences, paste controls, or modified keys. */
export function printableInput(raw: string): string | undefined {
  if (isKeyRelease(raw)) return undefined;
  const kitty = decodeKittyPrintable(raw);
  if (kitty !== undefined) return kitty;
  return raw && !/[\p{Cc}\p{Cs}]/u.test(raw) ? raw : undefined;
}

export function displayText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, "�");
}
/** Preserve already-redacted sentinels and honor union field sensitivity as well. */
export function safeEditorValue(
  schema: ValueSchema,
  value: JsonValue,
  sensitivity: Sensitivity = "public",
): JsonValue {
  if (isMasked(value)) return structuredClone(value);
  if (sensitivity === "masked")
    return maskValue(value, { schema, sensitivity });
  if (schema.kind === "union") {
    let safe = structuredClone(value);
    for (const variant of schema.variants)
      safe = safeEditorValue(variant, safe);
    return safe;
  }
  const masked = maskValue(value, { schema, sensitivity });
  if (Array.isArray(value) && Array.isArray(masked))
    return value.map((item, index) =>
      safeEditorValue(
        schema.kind === "list" ? schema.item : { kind: "json" },
        isMasked(masked[index] ?? null) ? (masked[index] as JsonValue) : item,
      ),
    );
  if (object(value) && object(masked)) {
    for (const [key, item] of Object.entries(value)) {
      const field =
        schema.kind === "structured" ? schema.fields[key] : undefined;
      const childSchema =
        field?.schema ??
        (schema.kind === "map" ? schema.value : ({ kind: "json" } as const));
      put(
        masked,
        key,
        isMasked(item)
          ? structuredClone(item)
          : isMasked(masked[key] ?? null)
            ? structuredClone(masked[key] as JsonValue)
            : safeEditorValue(
                childSchema,
                masked[key] ?? item,
                field?.sensitivity,
              ),
      );
    }
  }
  return masked;
}

function object(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function containsMask(value: JsonValue): boolean {
  return (
    isMasked(value) ||
    (Array.isArray(value)
      ? value.some(containsMask)
      : object(value) && Object.values(value).some(containsMask))
  );
}
function containsLegacyMask(value: JsonValue): boolean {
  if (isMasked(value))
    return !object(value) || typeof value.$token !== "string";
  return Array.isArray(value)
    ? value.some(containsLegacyMask)
    : object(value) && Object.values(value).some(containsLegacyMask);
}
function hasToken(value: JsonValue, token: string): boolean {
  if (isMasked(value)) return object(value) && value.$token === token;
  return Array.isArray(value)
    ? value.some((item) => hasToken(item, token))
    : object(value) &&
        Object.values(value).some((item) => hasToken(item, token));
}
/** Display text must never serialize opaque retention marker internals. */
export function editorDisplayValue(value: JsonValue): string {
  const display = (item: JsonValue): JsonValue =>
    isMasked(item)
      ? "[masked]"
      : Array.isArray(item)
        ? item.map(display)
        : object(item)
          ? Object.fromEntries(
              Object.entries(item).map(([key, child]) => [key, display(child)]),
            )
          : item;
  return displayText(JSON.stringify(display(value)));
}
function put(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Defaults are draft seeds, not presumed valid values or persistence operations. */
export function editorDefault(schema: ValueSchema): JsonValue {
  switch (schema.kind) {
    case "boolean":
      return false;
    case "text":
      return "";
    case "number":
      return schema.minimum ?? 0;
    case "choice":
      return schema.values[0] ?? null;
    case "union":
      return schema.variants[0] ? editorDefault(schema.variants[0]) : null;
    case "list":
      return [];
    case "map":
    case "structured":
      return {};
    case "json":
      return null;
  }
}

/** Validate a redacted draft without asking the UI to restore credentials. */
export function validEditorDraft(
  schema: ValueSchema,
  value: JsonValue,
  original: JsonValue,
  retainedRoot: JsonValue = original,
): boolean {
  if (isMasked(value))
    return object(value) && typeof value.$token === "string"
      ? hasToken(retainedRoot, value.$token)
      : isMasked(original);
  switch (schema.kind) {
    case "union":
      return schema.variants.some((variant) =>
        validEditorDraft(variant, value, original, retainedRoot),
      );
    case "list":
      return (
        Array.isArray(value) &&
        (schema.minItems === undefined || value.length >= schema.minItems) &&
        (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        value.every((item, index) =>
          validEditorDraft(
            schema.item,
            item,
            Array.isArray(original) ? (original[index] ?? null) : null,
            retainedRoot,
          ),
        )
      );
    case "map":
      return (
        object(value) &&
        Object.entries(value).every(([key, item]) =>
          validEditorDraft(
            schema.value,
            item,
            object(original) ? (original[key] ?? null) : null,
            retainedRoot,
          ),
        )
      );
    case "structured":
      return (
        object(value) &&
        Object.entries(schema.fields).every(([key, field]) =>
          !Object.hasOwn(value, key)
            ? !field.required
            : validEditorDraft(
                field.schema,
                value[key] as JsonValue,
                object(original) ? (original[key] ?? null) : null,
                retainedRoot,
              ),
        ) &&
        Object.keys(value).every(
          (key) =>
            Object.hasOwn(schema.fields, key) ||
            (schema.preserveUnknown &&
              validEditorDraft(
                { kind: "json" },
                value[key] as JsonValue,
                object(original) ? (original[key] ?? null) : null,
                retainedRoot,
              )),
        )
      );
    case "json":
      if (Array.isArray(value))
        return value.every((item, index) =>
          validEditorDraft(
            schema,
            item,
            Array.isArray(original) ? (original[index] ?? null) : null,
            retainedRoot,
          ),
        );
      if (object(value))
        return Object.entries(value).every(([key, item]) =>
          validEditorDraft(
            schema,
            item,
            object(original) ? (original[key] ?? null) : null,
            retainedRoot,
          ),
        );
      return validateValue(schema, value).valid;
    default:
      return validateValue(schema, value).valid;
  }
}

/** One entry's local draft tree. No writes, terminal loop, or raw-secret snapshot. */
export class TypedEditor {
  private readonly frames: Frame[] = [];
  private message = "";
  private ended = false;
  private captured: string | null = null;
  private captureMode: "menu" | "record" | "typed" = "menu";
  private readonly keyCapture: boolean;
  private readonly retainedRoot: JsonValue;
  private readonly suggestions: EditorSuggestions | undefined;

  constructor(
    schema: ValueSchema,
    value: JsonValue,
    options: {
      sensitivity?: Sensitivity;
      keyCapture?: boolean;
      existingValue?: boolean;
      suggestions?: EditorSuggestions;
      initialField?: string;
    } = {},
  ) {
    const sensitivity = options.sensitivity ?? "public";
    const safe =
      options.existingValue === false
        ? structuredClone(value)
        : safeEditorValue(schema, value, sensitivity);
    this.keyCapture = options.keyCapture ?? false;
    this.suggestions = options.suggestions;
    this.retainedRoot =
      options.existingValue === false ? null : structuredClone(safe);
    this.push(
      schema,
      safe,
      options.existingValue === false ? null : safe,
      sensitivity,
      [],
    );
    if (
      !this.keyCapture &&
      schema.kind === "structured" &&
      !isMasked(this.frame.value) &&
      options.initialField !== undefined &&
      Object.hasOwn(schema.fields, options.initialField)
    ) {
      // Use the ordinary field action so validation and return-to-form stay identical.
      const index = Object.keys(schema.fields).indexOf(options.initialField);
      this.actions()
        .filter((action) => action.action === "field")
        [index]?.run();
    }
  }

  private get frame(): Frame {
    return this.frames[this.frames.length - 1] as Frame;
  }

  private push(
    schema: ValueSchema,
    value: JsonValue,
    original: JsonValue,
    sensitivity: Sensitivity,
    path: string[],
    commit?: (value: JsonValue) => void,
    draftKey?: string | null,
  ): void {
    const buffer = isMasked(value)
      ? ""
      : schema.kind === "text"
        ? typeof value === "string"
          ? value
          : ""
        : schema.kind === "number"
          ? typeof value === "number"
            ? String(value)
            : ""
          : schema.kind === "json"
            ? JSON.stringify(value)
            : "";
    const selected =
      schema.kind === "choice"
        ? Math.max(
            0,
            schema.values.indexOf(value as string | number | boolean | null),
          )
        : schema.kind === "boolean" && value === true
          ? 1
          : 0;
    this.frames.push({
      schema,
      value: structuredClone(value),
      original: structuredClone(original),
      sensitivity:
        isMasked(value) || isMasked(original) ? "masked" : sensitivity,
      path,
      selected,
      buffer,
      cursor: Array.from(buffer).length,
      touched: false,
      sensitiveValues: new Set(
        Array.isArray(value) || object(value)
          ? Object.values(value).filter(isMasked)
          : [],
      ),
      ...(commit ? { commit } : {}),
      ...(draftKey !== undefined ? { draftKey } : {}),
    });
    this.resolveSuggestions();
  }

  private snapshot(frame: Frame): JsonValue {
    const value = structuredClone(frame.value);
    if (Array.isArray(value) || object(value)) {
      for (const [key, child] of Object.entries(frame.value as object)) {
        if (frame.sensitiveValues.has(child)) {
          const masked = maskValue(child, {
            schema: { kind: "json" },
            sensitivity: "masked",
          });
          if (Array.isArray(value)) value[Number(key)] = masked;
          else put(value, key, masked);
        }
      }
    }
    return safeEditorValue(frame.schema, value, frame.sensitivity);
  }

  private resolveSuggestions(): void {
    const f = this.frame;
    if (
      !this.suggestions ||
      this.keyCapture ||
      f.schema.kind !== "text" ||
      this.frames.some((frame) => frame.sensitivity !== "public") ||
      this.sensitivePath(f.path) ||
      this.hiddenInput(f)
    )
      return;
    try {
      const ancestors = this.frames.slice(0, -1);
      const parent = ancestors.at(-1);
      let root = parent ? this.snapshot(parent) : this.snapshot(f);
      // Include completed changes in open nested forms, not just the root frame.
      for (let index = ancestors.length - 1; index > 0; index--) {
        const child = ancestors[index] as Frame;
        const ancestor = this.snapshot(ancestors[index - 1] as Frame);
        if (child.draftKey === null) continue; // Union variant replaces its parent.
        if (child.draftKey !== undefined) {
          if (Array.isArray(ancestor)) ancestor[Number(child.draftKey)] = root;
          else if (object(ancestor)) put(ancestor, child.draftKey, root);
        }
        root = ancestor;
      }
      const context: EditorSuggestionContext = {
        path: [...f.path],
        rootValue: root,
        parentValue: parent ? this.snapshot(parent) : null,
        currentValue: structuredClone(f.value),
      };
      const references: string[] = [];
      const collect = (value: JsonValue): void => {
        if (isMasked(value)) {
          if (object(value) && typeof value.$token === "string")
            references.push(value.$token);
        } else if (Array.isArray(value) || object(value))
          Object.values(value).forEach(collect);
      };
      collect(root);
      collect(context.parentValue);
      const choices = this.suggestions(structuredClone(context));
      if (choices === undefined) return;
      const safe = (text: string): boolean =>
        !/\$token|\$piSettingsMasked/.test(text) &&
        !references.some((reference) => text.includes(reference)) &&
        safeDisplay(text, {
          schema: { kind: "text" },
          sensitivity: "public",
        }) === JSON.stringify(text);
      const seen = new Set<string>();
      const copied = choices
        .filter((choice) =>
          [choice.value, choice.label, choice.description ?? ""].every(safe),
        )
        .filter((choice) => {
          if (seen.has(choice.value)) return false;
          seen.add(choice.value);
          return true;
        })
        .map((choice) => ({
          value: choice.value,
          label: displayText(choice.label),
          description: displayText(choice.description ?? ""),
        }));
      if (typeof f.value === "string" && f.value && !seen.has(f.value))
        copied.unshift({
          value: f.value,
          label: safe(f.value)
            ? `Keep current value: ${displayText(f.value)}`
            : "Keep current value",
          description: "Retain this custom value unchanged.",
        });
      f.picker = { choices: copied, mode: "picker", filter: "", cursor: 0 };
      f.selected = Math.max(
        0,
        copied.findIndex((choice) => choice.value === f.value),
      );
    } catch {
      // Catalog failures must not expose diagnostics or disable typed editing.
      delete f.picker;
    }
  }

  private sensitivePath(path: readonly string[]): boolean {
    return path.some((part) =>
      /^(env|headers|apiKey|api_key|password|secret|clientSecret|accessToken|refreshToken|authorization|httpProxy)$/i.test(
        part,
      ),
    );
  }

  private finish(value: JsonValue): EditorOutcome {
    const frame = this.frame;
    if (
      !validEditorDraft(frame.schema, value, frame.original, this.retainedRoot)
    ) {
      this.message =
        "Value does not match the setting schema. Complete required fields and check constraints.";
      return editing;
    }
    if (frame.commit) {
      this.frames.pop();
      if (this.keyCapture) {
        this.captureMode = "typed";
        this.captured = null;
      }
      this.message = "Draft updated; complete the entry to save.";
      frame.commit(value);
      this.frame.selected = Math.min(
        this.frame.selected,
        this.actions().length - 1,
      );
      return editing;
    }
    this.ended = true;
    return { state: "complete", value: structuredClone(value) };
  }

  private child(
    schema: ValueSchema,
    value: JsonValue,
    original: JsonValue,
    path: string,
    sensitivity: Sensitivity,
    commit: (value: JsonValue) => void,
  ): EditorOutcome {
    const parent = this.frame;
    const sensitivePath = this.sensitivePath([...parent.path, path]);
    const childSensitivity =
      sensitivePath ||
      parent.sensitiveValues.has(value) ||
      isMasked(value) ||
      isMasked(original)
        ? "masked"
        : sensitivity;
    this.push(
      schema,
      value,
      original,
      childSensitivity,
      [...parent.path, path],
      (next) => {
        if (childSensitivity === "masked") parent.sensitiveValues.add(next);
        commit(next);
      },
      parent.schema.kind === "union" ? null : path,
    );
    if (this.keyCapture && schema.kind === "text") {
      this.captureMode = "record";
      this.captured = null;
    }
    this.message = "";
    return editing;
  }

  private actions(): Action[] {
    const f = this.frame;
    if (f.picker && this.hiddenInput(f)) {
      delete f.picker;
      f.selected = 0;
    }
    const actions: Action[] = [];
    const add = (
      label: string,
      description: string,
      action: string,
      run: () => EditorOutcome,
    ) => actions.push({ label, description, action, run });
    if (isMasked(f.value)) {
      add(
        "Retain masked value",
        "Keep the existing value without revealing it.",
        "retain",
        () => this.finish(f.value),
      );
      add(
        "Replace masked value",
        "Enter a deliberate replacement; empty text is not retention.",
        "replace",
        () => {
          f.value = editorDefault(f.schema);
          f.buffer =
            f.schema.kind === "json"
              ? JSON.stringify(f.value)
              : f.schema.kind === "number"
                ? String(f.value)
                : "";
          f.cursor = Array.from(f.buffer).length;
          f.touched = true;
          f.selected = 0;
          return editing;
        },
      );
      return actions;
    }
    if (f.picker?.mode === "picker") {
      const filter = f.picker.filter.toLocaleLowerCase();
      for (const choice of f.picker.choices) {
        if (
          ![choice.value, choice.label, choice.description ?? ""].some((text) =>
            text.toLocaleLowerCase().includes(filter),
          )
        )
          continue;
        add(choice.label, choice.description ?? "", "suggestion", () =>
          this.finish(choice.value),
        );
      }
      add(
        "Enter custom value…",
        "Type any schema-valid ID or pattern. Tab returns to choices.",
        "custom",
        () => {
          if (f.picker) f.picker.mode = "custom";
          f.selected = 0;
          return editing;
        },
      );
    } else
      switch (f.schema.kind) {
        case "boolean":
          for (const value of [false, true])
            add(String(value), "Select a boolean value.", "choice", () =>
              this.finish(value),
            );
          break;
        case "choice":
          for (const value of f.schema.values)
            add(
              f.sensitivity === "masked"
                ? "Hidden choice"
                : displayText(String(value)),
              "Select a permitted value.",
              "choice",
              () => this.finish(value),
            );
          break;
        case "union":
          for (const [index, variant] of f.schema.variants.entries())
            add(
              `Variant ${index + 1}: ${variant.kind}`,
              "Edit this allowed value type.",
              "variant",
              () =>
                this.child(
                  variant,
                  validEditorDraft(
                    variant,
                    f.value,
                    f.original,
                    this.retainedRoot,
                  )
                    ? f.value
                    : editorDefault(variant),
                  f.original,
                  variant.kind,
                  f.sensitivity,
                  (value) => {
                    f.value = value;
                  },
                ),
            );
          add("Complete entry", "Confirm this union value.", "complete", () =>
            this.finish(f.value),
          );
          break;
        case "list": {
          if (!Array.isArray(f.value)) f.value = [];
          const list = f.value as JsonValue[];
          const schema = f.schema.item;
          list.forEach((value, index) => {
            add(
              `Edit item ${index + 1}`,
              "Edit this item in a local draft.",
              "edit",
              () =>
                this.child(
                  schema,
                  value,
                  Array.isArray(f.original)
                    ? (f.original[index] ?? null)
                    : null,
                  String(index),
                  f.sensitivity,
                  (next) => {
                    list[index] = next;
                  },
                ),
            );
            add(
              `Remove item ${index + 1}`,
              "Remove from the draft, not storage.",
              "remove",
              () => {
                if (list.slice(index + 1).some(containsLegacyMask)) {
                  this.message =
                    "Replace retained masked fields in following items before shifting their positions.";
                } else {
                  list.splice(index, 1);
                  f.selected = Math.min(f.selected, this.actions().length - 1);
                }
                return editing;
              },
            );
            for (const offset of [-1, 1]) {
              const target = index + offset;
              if (target < 0 || target >= list.length) continue;
              add(
                `Move item ${index + 1} ${offset < 0 ? "up" : "down"}`,
                "Reorder this item in the local draft.",
                "move",
                () => {
                  if (
                    containsLegacyMask(value) ||
                    containsLegacyMask(list[target] as JsonValue)
                  )
                    this.message =
                      "Replace legacy retained masked fields before changing their positions.";
                  else {
                    const other = list[target] as JsonValue;
                    list[target] = list[index] as JsonValue;
                    list[index] = other;
                  }
                  return editing;
                },
              );
            }
          });
          add(
            "Add item",
            "Complete an item before adding it to this draft.",
            "add",
            () =>
              this.child(
                schema,
                editorDefault(schema),
                null,
                String(list.length),
                f.sensitivity,
                (next) => {
                  list.push(next);
                },
              ),
          );
          add(
            "Complete entry",
            "Validate and save the entire list entry.",
            "complete",
            () => this.finish(list),
          );
          break;
        }
        case "map": {
          if (!object(f.value)) f.value = {};
          const map = f.value as Record<string, JsonValue>;
          const schema = f.schema.value;
          for (const [key, value] of Object.entries(map)) {
            add(
              `Edit ${displayText(key)}`,
              "Edit this key's value.",
              "edit",
              () =>
                this.child(
                  schema,
                  value,
                  object(f.original) ? (f.original[key] ?? null) : null,
                  key,
                  f.sensitivity,
                  (next) => put(map, key, next),
                ),
            );
            add(
              `Rename ${displayText(key)}`,
              "Rename atomically when the whole entry is completed.",
              "rename",
              () => {
                if (containsLegacyMask(value)) {
                  this.message =
                    "Replace legacy retained masked fields before renaming their key.";
                  return editing;
                }
                return this.keyEditor(key, (next) => {
                  if (next !== key && Object.hasOwn(map, next)) return false;
                  delete map[key];
                  put(map, next, value);
                  return true;
                });
              },
            );
            add(
              `Remove ${displayText(key)}`,
              "Remove this key from the draft.",
              "remove",
              () => {
                delete map[key];
                f.selected = Math.min(f.selected, this.actions().length - 1);
                return editing;
              },
            );
          }
          add(
            "Add key",
            "Create a key, then edit its typed value.",
            "add",
            () =>
              this.keyEditor("", (key) => {
                if (Object.hasOwn(map, key)) return false;
                this.child(
                  schema,
                  editorDefault(schema),
                  null,
                  key,
                  f.sensitivity,
                  (next) => put(map, key, next),
                );
                return true;
              }),
          );
          add(
            "Complete entry",
            "Validate and save the entire map entry.",
            "complete",
            () => this.finish(map),
          );
          break;
        }
        case "structured": {
          if (!object(f.value)) f.value = {};
          const record = f.value as Record<string, JsonValue>;
          for (const [key, field] of Object.entries(f.schema.fields)) {
            const present = Object.hasOwn(record, key);
            add(
              `${displayText(key)} (${field.required ? "required" : "optional"}${present ? "" : ", absent"})`,
              displayText(field.description),
              "field",
              () =>
                this.child(
                  field.schema,
                  present
                    ? (record[key] as JsonValue)
                    : editorDefault(field.schema),
                  object(f.original) ? (f.original[key] ?? null) : null,
                  key,
                  f.sensitivity === "masked" ? "masked" : field.sensitivity,
                  (next) => put(record, key, next),
                ),
            );
            if (!field.required && present)
              add(
                `Remove ${displayText(key)}`,
                displayText(field.description),
                "remove",
                () => {
                  delete record[key];
                  f.selected = Math.min(f.selected, this.actions().length - 1);
                  return editing;
                },
              );
          }
          add(
            "Complete entry",
            "Validate required fields and save this entire entry.",
            "complete",
            () => this.finish(record),
          );
          break;
        }
        case "text":
        case "number":
        case "json":
          add(
            "Confirm value",
            "Enter confirms; Escape cancels the incomplete entry.",
            "confirm",
            () => {
              let value: JsonValue;
              try {
                if (f.schema.kind === "text") value = f.buffer;
                else if (f.schema.kind === "number") {
                  if (!f.buffer.trim()) throw new Error();
                  value = Number(f.buffer);
                } else value = JSON.parse(f.buffer) as JsonValue;
              } catch {
                this.message = "Enter a valid value for this field.";
                return editing;
              }
              return this.finish(value);
            },
          );
          break;
      }
    if (this.frames.length > 1)
      add(
        "Back without completing field",
        "Discard this field's incomplete draft.",
        "back",
        () => {
          this.frames.pop();
          this.message = "Field draft cancelled.";
          return editing;
        },
      );
    return actions;
  }

  private keyEditor(
    initial: string,
    commit: (key: string) => boolean,
  ): EditorOutcome {
    const parent = this.frame;
    this.push(
      { kind: "text", minLength: 1 },
      initial,
      initial,
      parent.sensitivity === "masked" ||
        this.sensitivePath([...parent.path, initial]) ||
        (object(parent.value) &&
          Object.hasOwn(parent.value, initial) &&
          (isMasked(parent.value[initial] as JsonValue) ||
            parent.sensitiveValues.has(parent.value[initial] as JsonValue)))
        ? "masked"
        : "public",
      [...parent.path, "key"],
      (value) => {
        if (!commit(value as string)) {
          this.message = "That map key already exists.";
          this.keyEditor(value as string, commit);
        }
      },
    );
    return editing;
  }

  private captureActions(): Action[] {
    const f = this.frame;
    const listSchema =
      f.schema.kind === "list"
        ? f.schema
        : f.schema.kind === "union"
          ? f.schema.variants.find((variant) => variant.kind === "list")
          : undefined;
    const actions: Action[] = [
      {
        label: "Record one key",
        description:
          "Enter starts capture; a separate Enter confirms the recorded key.",
        action: "record",
        run: () => {
          this.captureMode = "record";
          this.captured = null;
          f.selected = 0;
          return editing;
        },
      },
    ];
    if (listSchema?.kind === "list") {
      actions.push({
        label: "Edit assignment list",
        description:
          "Add, record, remove, or reorder individual assignments; Complete entry saves the list.",
        action: "assignments",
        run: () => {
          const value = Array.isArray(f.value)
            ? f.value
            : typeof f.value === "string" || isMasked(f.value)
              ? [f.value]
              : [];
          this.frames.length = 0;
          this.push(listSchema, value, f.original, f.sensitivity, []);
          this.captureMode = "typed";
          return editing;
        },
      });
      actions.push({
        label: "Disable action (empty assignment list)",
        description: "Confirm an empty list to disable this action.",
        action: "disable",
        run: () => this.finish([]),
      });
    }
    return actions;
  }

  handleInput(raw: string): EditorOutcome {
    if (this.ended || isKeyRelease(raw)) return editing;
    if (matchesKey(raw, "escape")) {
      this.ended = true;
      return { state: "cancelled" };
    }
    this.message = "";
    if (this.keyCapture && this.captureMode === "menu") {
      const actions = this.captureActions();
      if (matchesKey(raw, "up") || matchesKey(raw, "left"))
        this.frame.selected = Math.max(0, this.frame.selected - 1);
      else if (matchesKey(raw, "down") || matchesKey(raw, "right"))
        this.frame.selected = Math.min(
          actions.length - 1,
          this.frame.selected + 1,
        );
      else if (matchesKey(raw, "enter"))
        return actions[this.frame.selected]?.run() ?? editing;
      return editing;
    }
    if (this.keyCapture && this.captureMode === "record") {
      if (this.captured !== null && matchesKey(raw, "enter")) {
        const f = this.frame;
        const value: JsonValue =
          f.schema.kind === "list"
            ? [this.captured]
            : f.schema.kind === "union" &&
                !validEditorDraft(f.schema, this.captured, f.original)
              ? [this.captured]
              : this.captured;
        return this.finish(value);
      }
      const result = captureKey(raw);
      if (result.state === "captured") this.captured = result.key;
      else this.message = result.message;
      return editing;
    }
    const f = this.frame;
    if (f.picker && this.hiddenInput(f)) {
      delete f.picker;
      f.selected = 0;
    }
    if (f.picker && matchesKey(raw, "tab")) {
      f.picker.mode = f.picker.mode === "picker" ? "custom" : "picker";
      f.selected = 0;
      if (f.picker.mode === "picker") {
        const index = f.picker.choices
          .filter((choice) =>
            [choice.value, choice.label, choice.description ?? ""].some(
              (text) =>
                text
                  .toLocaleLowerCase()
                  .includes(f.picker?.filter.toLocaleLowerCase() ?? ""),
            ),
          )
          .findIndex((choice) => choice.value === f.buffer);
        f.selected = Math.max(0, index);
      }
      return editing;
    }
    const actions = this.actions();
    if (f.picker?.mode === "picker") {
      if (matchesKey(raw, "up")) f.selected = Math.max(0, f.selected - 1);
      else if (matchesKey(raw, "down"))
        f.selected = Math.min(actions.length - 1, f.selected + 1);
      else if (matchesKey(raw, "enter"))
        return actions[f.selected]?.run() ?? editing;
      else {
        const characters = Array.from(f.picker.filter);
        let changed = false;
        if (matchesKey(raw, "left"))
          f.picker.cursor = Math.max(0, f.picker.cursor - 1);
        else if (matchesKey(raw, "right"))
          f.picker.cursor = Math.min(characters.length, f.picker.cursor + 1);
        else if (matchesKey(raw, "home")) f.picker.cursor = 0;
        else if (matchesKey(raw, "end")) f.picker.cursor = characters.length;
        else if (matchesKey(raw, "backspace") && f.picker.cursor > 0) {
          characters.splice(--f.picker.cursor, 1);
          changed = true;
        } else if (matchesKey(raw, "delete")) {
          characters.splice(f.picker.cursor, 1);
          changed = true;
        } else {
          const text = printableInput(raw);
          if (text !== undefined) {
            characters.splice(f.picker.cursor, 0, ...Array.from(text));
            f.picker.cursor += Array.from(text).length;
            changed = true;
          }
        }
        if (changed) {
          f.picker.filter = characters.join("");
          f.selected = 0;
        }
      }
      return editing;
    }
    const scalar =
      !isMasked(f.value) && ["text", "number", "json"].includes(f.schema.kind);
    if (scalar) {
      const characters = Array.from(f.buffer);
      if (matchesKey(raw, "left")) f.cursor = Math.max(0, f.cursor - 1);
      else if (matchesKey(raw, "right"))
        f.cursor = Math.min(characters.length, f.cursor + 1);
      else if (matchesKey(raw, "home")) f.cursor = 0;
      else if (matchesKey(raw, "end")) f.cursor = characters.length;
      else if (matchesKey(raw, "backspace")) {
        if (f.cursor > 0) {
          characters.splice(--f.cursor, 1);
          f.touched = true;
        }
        f.buffer = characters.join("");
      } else if (matchesKey(raw, "delete")) {
        characters.splice(f.cursor, 1);
        f.buffer = characters.join("");
        f.touched = true;
      } else if (matchesKey(raw, "enter"))
        return (actions[f.selected] ?? actions[0])?.run() ?? editing;
      else if (matchesKey(raw, "up")) f.selected = Math.max(0, f.selected - 1);
      else if (matchesKey(raw, "down"))
        f.selected = Math.min(actions.length - 1, f.selected + 1);
      else {
        const text = printableInput(raw);
        if (text !== undefined) {
          characters.splice(f.cursor, 0, ...Array.from(text));
          f.cursor += Array.from(text).length;
          f.buffer = characters.join("");
          f.touched = true;
        }
      }
    } else if (matchesKey(raw, "up") || matchesKey(raw, "left"))
      f.selected = Math.max(0, f.selected - 1);
    else if (matchesKey(raw, "down") || matchesKey(raw, "right"))
      f.selected = Math.min(actions.length - 1, f.selected + 1);
    else if (matchesKey(raw, "enter"))
      return actions[f.selected]?.run() ?? editing;
    return editing;
  }

  private hiddenInput(frame: Frame): boolean {
    if (frame.sensitivity === "masked" || containsMask(frame.value))
      return true;
    if (frame.schema.kind === "text")
      return [
        frame.buffer,
        ...(frame.picker ? [frame.picker.filter] : []),
      ].some(
        (text) =>
          safeDisplay(text, {
            schema: frame.schema,
            sensitivity: "public",
          }) !== JSON.stringify(text),
      );
    if (frame.schema.kind === "json") {
      if (
        /"(?:env|headers|apiKey|api_key|password|secret|clientSecret|accessToken|refreshToken|authorization|httpProxy)"\s*:/i.test(
          frame.buffer,
        )
      )
        return true;
      try {
        const value = JSON.parse(frame.buffer) as JsonValue;
        return (
          safeDisplay(value, {
            schema: frame.schema,
            sensitivity: "public",
          }) !== JSON.stringify(value)
        );
      } catch {
        return false;
      }
    }
    return false;
  }

  view(): EditorView {
    const f = this.frame;
    const actions =
      this.keyCapture && this.captureMode === "menu"
        ? this.captureActions()
        : this.keyCapture && this.captureMode === "record"
          ? [
              {
                label: this.captured
                  ? `Captured: ${displayText(this.captured)} — Enter to confirm`
                  : "Press a key to record",
                description:
                  "Recording does not save; a second Enter confirms.",
                action: "capture",
              },
            ]
          : this.actions();
    const scalar =
      !isMasked(f.value) && ["text", "number", "json"].includes(f.schema.kind);
    const input =
      scalar && (!this.keyCapture || this.captureMode === "typed")
        ? this.hiddenInput(f)
          ? "[hidden draft]"
          : displayText(
              f.picker?.mode === "picker" ? f.picker.filter : f.buffer,
            )
        : null;
    return {
      kind:
        this.keyCapture && this.captureMode !== "typed"
          ? "keybinding"
          : f.schema.kind,
      path: [...f.path],
      lines: actions.map((action, index) => ({
        label: action.label,
        description: action.description,
        action: action.action,
        selected: index === f.selected,
      })),
      selected: f.selected,
      input,
      cursor:
        input === "[hidden draft]"
          ? 0
          : f.picker?.mode === "picker"
            ? f.picker.cursor
            : f.cursor,
      message: this.message,
      ...(f.picker?.mode === "picker" ? { picking: true } : {}),
      help: f.picker
        ? f.picker.mode === "picker"
          ? "Type to filter choices. Up/Down selects; Enter confirms. Tab enters a custom value. Escape cancels the incomplete entry."
          : "Type any schema-valid custom value. Enter confirms; Tab returns to choices. Escape cancels the incomplete entry."
        : "Arrows and typing edit this entry only. Enter confirms. Escape cancels the incomplete entry.",
    };
  }
}
