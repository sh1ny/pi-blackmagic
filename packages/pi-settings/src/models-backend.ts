import { readConfiguration } from "./configuration-read.ts";
import type {
  EditResult,
  JsonValue,
  Revision,
  Scope,
  ScopedReadResult,
  ValidationResult,
  ValueSchema,
} from "./contracts.ts";
import {
  MODEL_SCHEMA,
  MODEL_OVERRIDE_SCHEMA,
  MODELS_SCHEMA,
  PROVIDER_SCHEMA,
} from "./models-schema.ts";
import { resolveConfigurationPath, type ProjectContext } from "./paths.ts";
import {
  entryRevision,
  persistEntry,
  readEntry,
  type EntrySnapshot,
  type SemanticMutation,
} from "./persistence.ts";
import {
  isMasked,
  maskValue,
  restoreMasked,
  safeDiagnostic,
} from "./redaction.ts";
import { isJsonValue, validateValue } from "./validation.ts";

function object(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function put(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
function validate(schema: ValueSchema, value: JsonValue): ValidationResult {
  return isJsonValue(value)
    ? validateValue(schema, value)
    : { valid: false, message: "Configuration must contain JSON values only." };
}
export function validateModelsConfiguration(
  value: JsonValue,
): ValidationResult {
  return validate(MODELS_SCHEMA, value);
}
const rejection = (
  message: string,
  reason: "validation" | "conflict" | "unavailable" = "validation",
): EditResult => ({ state: "rejected", reason, message });

/** Keep unadvertised future fields at every known structured node, not a stale whole-file snapshot. */
function retainUnknown(
  draft: JsonValue,
  original: JsonValue | undefined,
  schema: ValueSchema,
): JsonValue {
  if (schema.kind === "structured" && object(draft) && object(original)) {
    const result = structuredClone(draft);
    for (const [key, value] of Object.entries(original)) {
      const field = schema.fields[key];
      if (!field && !Object.hasOwn(result, key))
        put(result, key, structuredClone(value));
      else if (field && Object.hasOwn(result, key))
        put(
          result,
          key,
          retainUnknown(result[key] as JsonValue, value, field.schema),
        );
    }
    return result;
  }
  if (schema.kind === "map" && object(draft)) {
    return Object.fromEntries(
      Object.entries(draft).map(([key, value]) => [
        key,
        retainUnknown(
          value,
          object(original) ? original[key] : undefined,
          schema.value,
        ),
      ]),
    );
  }
  if (schema.kind === "list" && Array.isArray(draft)) {
    return draft.map((value, index) =>
      retainUnknown(
        value,
        Array.isArray(original) ? original[index] : undefined,
        schema.item,
      ),
    );
  }
  if (schema.kind === "union") {
    const branch = schema.variants.find(
      (candidate) => validate(candidate, draft).valid,
    );
    if (branch) return retainUnknown(draft, original, branch);
  }
  return structuredClone(draft);
}
function complete(
  draft: JsonValue,
  original: JsonValue | undefined,
  schema: ValueSchema,
): JsonValue {
  return retainUnknown(
    restoreMasked(draft, original ?? null),
    original,
    schema,
  );
}

function containsMasked(value: JsonValue): boolean {
  return (
    isMasked(value) ||
    ((Array.isArray(value) || object(value)) &&
      Object.values(value).some(containsMasked))
  );
}

/** Credential-blind user models.json editor. Reads and acknowledged values are masked. */
export class ModelsBackend {
  constructor(
    private readonly context: ProjectContext,
    private readonly agentDirectory?: () => string,
  ) {}

  private location(scope: Scope) {
    return resolveConfigurationPath(
      "models",
      scope,
      this.context,
      this.agentDirectory,
    );
  }
  private available(
    entry: EntrySnapshot,
    revision: Revision,
  ): Extract<ScopedReadResult, { state: "available" }> {
    return {
      state: "available",
      scope: "user",
      configured: entry.present
        ? {
            present: true,
            value: maskValue(entry.value, {
              schema: PROVIDER_SCHEMA,
              sensitivity: "public",
            }),
          }
        : { present: false },
      effective: { known: false },
      revision,
      provenance: { source: "user", sessionState: "unknown" },
    };
  }
  private async snapshot(
    name: string,
    scope: Scope,
  ): Promise<
    | { state: "available"; entry: EntrySnapshot }
    | Exclude<ScopedReadResult, { state: "available" }>
  > {
    try {
      const location = this.location(scope);
      if (location.state === "unavailable")
        return { state: "unavailable", scope, reason: location.reason };
      const root = await readConfiguration(location, true);
      if (root.state !== "available")
        return root.state === "error"
          ? { state: "error", scope, message: root.message }
          : { state: "unavailable", scope, reason: root.reason };
      if (root.exists && !validateModelsConfiguration(root.value).valid)
        return {
          state: "error",
          scope,
          message:
            "Models configuration does not match the supported schema; repair it before editing.",
        };
      return {
        state: "available",
        entry: readEntry(root.value, ["providers", name]),
      };
    } catch (error) {
      return { state: "error", scope, message: safeDiagnostic(error, "read") };
    }
  }
  async readProvider(
    name: string,
    scope: Scope = "user",
  ): Promise<ScopedReadResult> {
    const snapshot = await this.snapshot(name, scope);
    return snapshot.state === "available"
      ? this.available(snapshot.entry, entryRevision(snapshot.entry))
      : snapshot;
  }

  private async mutate(
    name: string,
    expectedRevision: Revision,
    scope: Scope,
    transform: (
      original: JsonValue | undefined,
    ) => SemanticMutation["change"] | EditResult,
  ): Promise<EditResult> {
    if (scope !== "user")
      return rejection(
        "Models configuration supports user scope only.",
        "unavailable",
      );
    if (!name.length) return rejection("A provider identifier is required.");
    try {
      const snapshot = await this.snapshot(name, scope);
      if (snapshot.state !== "available")
        return snapshot.state === "unavailable"
          ? rejection(snapshot.reason, "unavailable")
          : { state: "failed", message: snapshot.message };
      if (entryRevision(snapshot.entry) !== expectedRevision)
        return rejection(
          "This provider changed externally; refresh and re-edit.",
          "conflict",
        );
      const change = transform(
        snapshot.entry.present ? snapshot.entry.value : undefined,
      );
      if ("state" in change) return change;
      const result = await persistEntry({
        location: () => this.location(scope),
        allowComments: true,
        mutation: { path: ["providers", name], expectedRevision, change },
        validateEntry: (value) => validate(PROVIDER_SCHEMA, value),
        validateConfiguration: validateModelsConfiguration,
      });
      return result.state === "persisted"
        ? {
            state: "persisted",
            read: this.available(result.entry, result.revision),
            activation: { state: "required", requirement: "reload" },
          }
        : result;
    } catch (error) {
      return { state: "failed", message: safeDiagnostic(error, "write") };
    }
  }
  async writeProvider(
    name: string,
    value: JsonValue,
    expectedRevision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.mutate(name, expectedRevision, scope, (original) => {
      // Restore before narrowing the original: opaque references may point to
      // models that have moved or whose earlier duplicate has been deleted.
      const restored = restoreMasked(value, original ?? null);
      // Match model drafts by identity, not by index: reordering must not move secrets.
      let aligned = original;
      if (
        object(original) &&
        object(value) &&
        Array.isArray(value.models) &&
        Array.isArray(original.models)
      ) {
        // Prefer a duplicate compatible with the original masked draft so its
        // omitted future fields stay with its retained secrets. Consume once.
        const remaining = [...original.models];
        aligned = {
          ...original,
          models: value.models.map((model) => {
            if (!object(model)) return null;
            let index = remaining.findIndex((old) => {
              if (!object(old) || old.id !== model.id) return false;
              try {
                restoreMasked(model, old);
                return true;
              } catch {
                return false;
              }
            });
            if (index < 0)
              index = remaining.findIndex(
                (old) => object(old) && old.id === model.id,
              );
            return index < 0 ? null : (remaining.splice(index, 1)[0] ?? null);
          }),
        };
      }
      return {
        operation: "set",
        value: retainUnknown(restored, aligned, PROVIDER_SCHEMA),
      };
    });
  }
  async renameProvider(
    name: string,
    destination: string,
    expectedRevision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.mutate(name, expectedRevision, scope, (original) =>
      !destination.length
        ? rejection("A destination provider identifier is required.")
        : original === undefined
          ? rejection("The provider does not exist.")
          : { operation: "rename", destination, value: original },
    );
  }
  async deleteProvider(
    name: string,
    expectedRevision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.mutate(name, expectedRevision, scope, () => ({
      operation: "remove",
    }));
  }

  /** Model and override edits share the provider revision and return the refreshed provider. */
  private async modelMutation(
    provider: string,
    revision: Revision,
    scope: Scope,
    edit: (value: Record<string, JsonValue>) => EditResult | undefined,
  ): Promise<EditResult> {
    return this.mutate(provider, revision, scope, (original) => {
      if (!object(original))
        return rejection("Create the provider before editing its models.");
      const value = structuredClone(original);
      const error = edit(value);
      return error ?? { operation: "set", value };
    });
  }
  async addModel(
    provider: string,
    model: JsonValue,
    revision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.modelMutation(provider, revision, scope, (value) => {
      if (!validate(MODEL_SCHEMA, model).valid || !object(model))
        return rejection("Model validation failed.");
      if (containsMasked(model))
        return rejection("A new model cannot retain masked fields.");
      const models = Array.isArray(value.models) ? value.models : [];
      if (models.some((old) => object(old) && old.id === model.id))
        return rejection("The model identifier already exists.", "conflict");
      value.models = [...models, structuredClone(model)];
    });
  }
  async editModel(
    provider: string,
    id: string,
    model: JsonValue,
    revision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.modelMutation(provider, revision, scope, (value) => {
      const models = Array.isArray(value.models) ? value.models : [];
      const indices = models.flatMap((model, index) =>
        object(model) && model.id === id ? [index] : [],
      );
      if (indices.length !== 1)
        return rejection("The model must have a unique existing identifier.");
      if (!object(model) || model.id !== id)
        return rejection("Use renameModel to change the model identifier.");
      models[indices[0] as number] = complete(
        model,
        models[indices[0] as number],
        MODEL_SCHEMA,
      );
    });
  }
  async renameModel(
    provider: string,
    id: string,
    destination: string,
    revision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.modelMutation(provider, revision, scope, (value) => {
      if (!destination.length)
        return rejection("A destination model identifier is required.");
      const models = Array.isArray(value.models) ? value.models : [];
      const matches = models.filter(
        (model) => object(model) && model.id === id,
      );
      if (matches.length !== 1)
        return rejection("The model must have a unique existing identifier.");
      if (id === destination) return;
      const overrides = object(value.modelOverrides)
        ? value.modelOverrides
        : undefined;
      if (
        models.some((model) => object(model) && model.id === destination) ||
        (overrides && Object.hasOwn(overrides, destination))
      )
        return rejection(
          "The destination model or override already exists.",
          "conflict",
        );
      (matches[0] as Record<string, JsonValue>).id = destination;
      if (overrides && Object.hasOwn(overrides, id)) {
        put(overrides, destination, overrides[id] as JsonValue);
        delete overrides[id];
      }
    });
  }
  async deleteModel(
    provider: string,
    id: string,
    revision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.modelMutation(provider, revision, scope, (value) => {
      const models = Array.isArray(value.models) ? value.models : [];
      if (
        models.filter((model) => object(model) && model.id === id).length !== 1
      )
        return rejection("The model must have a unique existing identifier.");
      value.models = models.filter(
        (model) => !object(model) || model.id !== id,
      );
      // Overrides may target built-in models: deletion does not implicitly remove one.
    });
  }
  async writeOverride(
    provider: string,
    id: string,
    override: JsonValue,
    revision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.modelMutation(provider, revision, scope, (value) => {
      if (!id.length)
        return rejection("An override model identifier is required.");
      const overrides = object(value.modelOverrides)
        ? value.modelOverrides
        : {};
      put(
        overrides,
        id,
        complete(
          override,
          Object.hasOwn(overrides, id) ? overrides[id] : undefined,
          MODEL_OVERRIDE_SCHEMA,
        ),
      );
      value.modelOverrides = overrides;
    });
  }
  async renameOverride(
    provider: string,
    id: string,
    destination: string,
    revision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.modelMutation(provider, revision, scope, (value) => {
      const overrides = object(value.modelOverrides)
        ? value.modelOverrides
        : {};
      if (!destination.length || !Object.hasOwn(overrides, id))
        return rejection(
          "An existing override and destination identifier are required.",
        );
      if (id === destination) return;
      if (Object.hasOwn(overrides, destination))
        return rejection(
          "The destination override already exists.",
          "conflict",
        );
      put(overrides, destination, overrides[id] as JsonValue);
      delete overrides[id];
    });
  }
  async deleteOverride(
    provider: string,
    id: string,
    revision: Revision,
    scope: Scope = "user",
  ): Promise<EditResult> {
    return this.modelMutation(provider, revision, scope, (value) => {
      if (
        !object(value.modelOverrides) ||
        !Object.hasOwn(value.modelOverrides, id)
      )
        return rejection("The override does not exist.");
      delete value.modelOverrides[id];
    });
  }
}
