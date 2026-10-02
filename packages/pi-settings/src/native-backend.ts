import { dirname, join } from "node:path";
import { readConfiguration } from "./configuration-read.ts";
import type {
  EditResult,
  EditTransaction,
  JsonValue,
  OperationContext,
  Scope,
  ScopedReadResult,
  SettingDescriptor,
  SettingsOperations,
  ValidationResult,
  ValueSchema,
} from "./contracts.ts";
import { activateNative, NATIVE_ACTIVATION } from "./native-activation.ts";
import { NATIVE_DEFAULTS, NATIVE_DESCRIPTORS } from "./native-catalog.ts";
import {
  combinedResources,
  mergeNativeSettings,
  resolvedTools,
} from "./native-merge.ts";
import { resolveConfigurationPath } from "./paths.ts";
import type { ProjectContext } from "./paths.ts";
import { entryRevision, persistEntry, readEntry } from "./persistence.ts";
import { restoreMasked } from "./redaction.ts";
import { validateValue } from "./validation.ts";

export interface NativeBackendOptions {
  context: ProjectContext;
  agentDirectory?: () => string;
  /** Read-only active host snapshot; absent values are not invented session state. */
  hostSettings?: () => Record<string, JsonValue>;
  applyTheme?: (
    theme: string,
  ) => Promise<{ success: boolean }> | { success: boolean };
}

export class NativeBackend implements SettingsOperations {
  readonly descriptors = new Map<string, SettingDescriptor>(
    NATIVE_DESCRIPTORS.map((descriptor) => [
      descriptor.id,
      {
        ...descriptor,
        activation: NATIVE_ACTIVATION[descriptor.id] ?? "reload",
      },
    ]),
  );
  constructor(private readonly options: NativeBackendOptions) {}

  /** Explicit typed descendants allow independent map-entry revisions and remove-override patches. */
  entryDescriptor(
    baseId: string,
    suffix: readonly string[],
  ): SettingDescriptor {
    const base = this.descriptors.get(baseId);
    if (!base) throw new Error("Unknown native setting.");
    let schema: ValueSchema = base.schema;
    for (const part of suffix) {
      if (schema.kind === "map") schema = schema.value;
      else if (
        schema.kind === "structured" &&
        Object.hasOwn(schema.fields, part)
      )
        schema = schema.fields[part]?.schema as ValueSchema;
      else throw new Error("This setting does not support that entry path.");
    }
    const descriptor: SettingDescriptor = {
      ...base,
      id: `${baseId}:${JSON.stringify(suffix)}`,
      path: [...base.path, ...suffix],
      label: [...base.path, ...suffix].join("."),
      schema,
    };
    this.descriptors.set(descriptor.id, descriptor);
    return descriptor;
  }

  private location(scope: Scope) {
    return resolveConfigurationPath(
      "native",
      scope,
      this.options.context,
      this.options.agentDirectory,
    );
  }

  async read(
    descriptorId: string,
    scope: Scope,
    _context?: OperationContext,
  ): Promise<ScopedReadResult> {
    const descriptor = this.descriptors.get(descriptorId);
    if (!descriptor?.scopes.includes(scope))
      return {
        state: "unavailable",
        scope,
        reason: "This setting does not support the selected scope.",
      };
    const location = this.location(scope);
    if (location.state === "unavailable")
      return { state: "unavailable", scope, reason: location.reason };
    const userLocation = this.location("user");
    if (userLocation.state !== "available")
      return {
        state: "error",
        scope,
        message: "User configuration is unavailable.",
      };
    const user = await readConfiguration(userLocation);
    if (user.state !== "available")
      return {
        state: "error",
        scope,
        message:
          user.state === "error"
            ? user.message
            : "User configuration is unavailable.",
      };
    const projectLocation = this.location("project");
    const project =
      projectLocation.state === "available"
        ? await readConfiguration(projectLocation)
        : undefined;
    if (project && project.state !== "available")
      return {
        state: "error",
        scope,
        message:
          project.state === "error"
            ? project.message
            : "Project configuration is unavailable.",
      };
    const local = project?.state === "available" ? project.value : {};
    const configured = readEntry(
      scope === "user" ? user.value : local,
      descriptor.path,
    );
    const merged = mergeNativeSettings(user.value, local);
    const saved = readEntry(merged, descriptor.path);
    const userEntry = readEntry(user.value, descriptor.path);
    const projectEntry = descriptor.scopes.includes("project")
      ? readEntry(local, descriptor.path)
      : { present: false as const };
    const path = descriptor.path.join(".");
    const resource = combinedResources(path, user.value, local, {
      user: dirname(userLocation.path),
      project:
        projectLocation.state === "available"
          ? dirname(projectLocation.path)
          : join(this.options.context.cwd, ".pi"),
    });
    let effective =
      resource !== undefined
        ? { known: true as const, value: resource }
        : saved.present
          ? { known: true as const, value: saved.value }
          : Object.hasOwn(NATIVE_DEFAULTS, path)
            ? {
                known: true as const,
                value: structuredClone(NATIVE_DEFAULTS[path] as JsonValue),
              }
            : { known: false as const };
    if (path === "defaultTools")
      effective = {
        known: true,
        value: resolvedTools(saved.present ? saved.value : undefined),
      };
    if (path === "retry.provider.timeoutMs" && !saved.present) {
      const timeout = readEntry(merged, ["httpIdleTimeoutMs"]);
      effective = {
        known: true,
        value: timeout.present
          ? timeout.value
          : (NATIVE_DEFAULTS.httpIdleTimeoutMs as JsonValue),
      };
    }
    let source: "user" | "project" | "default" | "host-override" =
      projectEntry.present ? "project" : userEntry.present ? "user" : "default";
    let sessionState: "known" | "unknown" = "unknown";
    if (this.options.hostSettings && resource === undefined) {
      const host = readEntry(this.options.hostSettings(), descriptor.path);
      if (host.present) {
        sessionState = "known";
        if (!saved.present || entryRevision(host) !== entryRevision(saved)) {
          source = "host-override";
          effective = { known: true, value: host.value };
        }
      }
    }
    return {
      state: "available",
      scope,
      configured,
      effective,
      revision: entryRevision(configured),
      provenance: { source, sessionState },
    };
  }

  async validate(
    transaction: EditTransaction,
    _context?: OperationContext,
  ): Promise<ValidationResult> {
    const descriptor = this.descriptors.get(transaction.descriptorId);
    if (!descriptor?.scopes.includes(transaction.scope))
      return {
        valid: false,
        message: "This setting does not support the selected scope.",
      };
    if (transaction.operation === "rename")
      return {
        valid: false,
        message: "Use a structured entry transaction to rename map keys.",
      };
    return transaction.operation === "remove-override"
      ? { valid: true }
      : validateValue(descriptor.schema, transaction.value);
  }

  async write(
    transaction: EditTransaction,
    context?: OperationContext,
  ): Promise<EditResult> {
    const descriptor = this.descriptors.get(transaction.descriptorId);
    if (!descriptor?.scopes.includes(transaction.scope))
      return {
        state: "rejected",
        reason: "unavailable",
        message: "This setting does not support the selected scope.",
      };
    let completed = transaction;
    if (transaction.operation === "set") {
      const current = await this.read(
        transaction.descriptorId,
        transaction.scope,
      );
      if (current.state !== "available")
        return {
          state: "rejected",
          reason: "unavailable",
          message: "Configuration is unavailable; refresh before retrying.",
        };
      try {
        completed = {
          ...transaction,
          value: restoreMasked(
            transaction.value,
            current.configured.present ? current.configured.value : null,
          ),
        };
      } catch {
        return {
          state: "rejected",
          reason: "validation",
          message: "A masked field has no original value.",
        };
      }
    }
    if (
      !(await this.validate(completed)).valid ||
      completed.operation === "rename"
    )
      return {
        state: "rejected",
        reason: "validation",
        message: "Native setting validation failed.",
      };
    const result = await persistEntry({
      location: () => this.location(completed.scope),
      mutation: {
        path: descriptor.path,
        expectedRevision: completed.expectedRevision,
        change:
          completed.operation === "remove-override"
            ? { operation: "remove" }
            : { operation: "set", value: completed.value },
      },
      validateEntry: (value) => validateValue(descriptor.schema, value),
      // Known fields are validated; unknown future content is never discarded or advertised.
      validateConfiguration: (value) => {
        for (const entry of NATIVE_DESCRIPTORS) {
          const configured = readEntry(value, entry.path);
          if (
            configured.present &&
            !validateValue(entry.schema, configured.value).valid
          )
            return {
              valid: false,
              message: "Native configuration validation failed.",
            };
        }
        return { valid: true };
      },
      ...(context ? { signal: context.signal } : {}),
    });
    if (result.state !== "persisted") return result;
    const refreshed = await this.read(completed.descriptorId, completed.scope);
    // Acknowledged persistence is not turned into a fictitious disk failure if refresh becomes unavailable.
    const read: Extract<ScopedReadResult, { state: "available" }> =
      refreshed.state === "available"
        ? refreshed
        : {
            state: "available",
            scope: completed.scope,
            configured: result.entry,
            effective: { known: false },
            revision: result.revision,
            provenance: { source: completed.scope, sessionState: "unknown" },
          };
    const activateValue =
      completed.operation === "set"
        ? completed.value
        : read.effective.known
          ? read.effective.value
          : undefined;
    return {
      state: "persisted",
      read,
      activation: await activateNative(
        descriptor.id,
        activateValue,
        this.options.applyTheme,
      ),
    };
  }

  async removeOverride(
    transaction: Extract<EditTransaction, { operation: "remove-override" }>,
    context?: OperationContext,
  ): Promise<EditResult> {
    return this.write(transaction, context);
  }
}
