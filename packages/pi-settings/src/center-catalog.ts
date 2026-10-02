import { createHash } from "node:crypto";
import { readConfiguration } from "./configuration-read.ts";
import type {
  EditResult,
  EditTransaction,
  JsonValue,
  Scope,
  ScopedReadResult,
  SettingDescriptor,
  SettingsOperations,
  ValueSchema,
} from "./contracts.ts";
import {
  KeybindingsBackend,
  type EffectiveKeybindings,
} from "./keybindings-backend.ts";
import type { ConflictWarning } from "./keybindings-validation.ts";
import { McpBackend } from "./mcp-backend.ts";
import { MCP_SERVER_SCHEMA, validateMcpConfiguration } from "./mcp-schema.ts";
import {
  ModelsBackend,
  validateModelsConfiguration,
} from "./models-backend.ts";
import { PROVIDER_SCHEMA } from "./models-schema.ts";
import { ModelChoices, type LocalModelSource } from "./model-choices.ts";
import { NativeBackend, type NativeBackendOptions } from "./native-backend.ts";
import { type ProjectContext, resolveConfigurationPath } from "./paths.ts";
import { entryRevision } from "./persistence.ts";
import type { SettingsRegistry } from "./registry.ts";
import type { CenterRow } from "./ui-controller.ts";
import { validateValue } from "./validation.ts";

export interface CenterCatalogOptions {
  context: ProjectContext;
  agentDirectory?: NativeBackendOptions["agentDirectory"];
  hostSettings?: NativeBackendOptions["hostSettings"];
  applyTheme?: NativeBackendOptions["applyTheme"];
  keybindings: EffectiveKeybindings;
  registry: SettingsRegistry;
  modelCatalog?: LocalModelSource;
  /** Publish rows to the controller; this callback never owns acknowledgement state. */
  onChange: () => void;
}

type AvailableRead = Extract<ScopedReadResult, { state: "available" }>;
const absentRevision = entryRevision({ present: false });
const named: ValueSchema = { kind: "text", minLength: 1 };
const scopes = ["user", "project"] as const;
const rejected = (
  reason: "validation" | "unavailable" | "conflict",
): EditResult => ({
  state: "rejected",
  reason,
  message:
    "Settings entry is unavailable, invalid, or changed; refresh before retrying.",
});

/** Identifiers remain private in closures; unusual names never enter search metadata. */
function metadata(text: string): string {
  if (
    /[\p{Cc}\p{Cf}]|(?:[a-z][a-z\d+.-]*:\/\/)|[A-Za-z\d_=-]{48,}/iu.test(text)
  )
    return "Private metadata";
  return text.slice(0, 1024);
}
function identity(kind: string, name: string): string {
  return `${kind}:${createHash("sha256").update(name).digest("hex")}`;
}
function absent(scope: Scope): AvailableRead {
  return {
    state: "available",
    scope,
    configured: { present: false },
    effective: { known: false },
    revision: absentRevision,
    provenance: { source: "default", sessionState: "unknown" },
  };
}
function scalar(read: ScopedReadResult, name: string): ScopedReadResult {
  return read.state !== "available"
    ? read
    : {
        ...read,
        configured: read.configured.present
          ? { present: true, value: name }
          : { present: false },
        effective: read.effective.known
          ? { known: true, value: name }
          : { known: false },
      };
}
function scalarResult(result: EditResult, name: string): EditResult {
  return result.state === "persisted"
    ? { ...result, read: scalar(result.read, name) as AvailableRead }
    : result;
}
function createSchema(definition: ValueSchema, label: string): ValueSchema {
  return {
    kind: "structured",
    preserveUnknown: false,
    fields: {
      name: {
        schema: named,
        required: true,
        sensitivity: "public",
        description: `${label} identifier.`,
      },
      definition: {
        schema: definition,
        required: true,
        sensitivity: "public",
        description: `${label} configuration.`,
      },
    },
  };
}

/** Schema-only discovery, including absent optional fields. Never inspect configured values here. */
function searchable(
  descriptor: SettingDescriptor,
  schemaPath = descriptor.path.map(metadata).join("."),
): SettingDescriptor {
  const parts = [...(descriptor.searchTerms ?? []).map(metadata)];
  function visit(schema: ValueSchema, path: string): void {
    parts.push(metadata(path));
    if (schema.kind === "structured") {
      for (const [name, field] of Object.entries(schema.fields)) {
        parts.push(metadata(field.description));
        visit(field.schema, `${path}.${metadata(name)}`);
      }
    } else if (schema.kind === "map") visit(schema.value, `${path}.*`);
    else if (schema.kind === "list") visit(schema.item, `${path}[]`);
    else if (schema.kind === "union")
      for (const variant of schema.variants) visit(variant, path);
  }
  visit(descriptor.schema, schemaPath);
  return {
    ...descriptor,
    id:
      /^(?:mcp|models|extension-setting):[a-f0-9]{64}(?::rename)?$/.test(
        descriptor.id,
      ) || metadata(descriptor.id) === descriptor.id
        ? descriptor.id
        : identity("extension-setting", descriptor.id),
    providerId: metadata(descriptor.providerId),
    pageId: metadata(descriptor.pageId),
    path: descriptor.path.map(metadata),
    label: metadata(descriptor.label),
    sourceLabel: metadata(descriptor.sourceLabel),
    description: metadata(descriptor.description),
    searchTerms: [...new Set(parts)],
  };
}
function descriptor(
  id: string,
  page: string,
  path: string[],
  label: string,
  schema: ValueSchema,
  supported: readonly Scope[] = scopes,
): SettingDescriptor {
  return {
    id,
    providerId: page.toLowerCase(),
    pageId: page,
    path,
    label,
    description: label,
    sourceLabel: page,
    schema,
    scopes: supported,
    sensitivity: "public",
    activation: "reload",
  };
}

/**
 * Storage-only row adapter. The host calls refresh on registry changes (no auto-refresh
 * subscription). A lightweight subscription immediately publishes extension
 * generations, including callback-only replacements whose descriptors are unchanged,
 * without waiting for configuration I/O before cancelling stale drafts.
 * Dispose aborts this session, not the host-owned registry. Refresh never replaces
 * surviving backend rows or touches the controller's pending acknowledgement.
 */
export class CenterCatalog {
  private readonly session = new AbortController();
  private readonly native: NativeBackend;
  private readonly keys: KeybindingsBackend;
  private readonly mcp: McpBackend;
  private readonly models: ModelsBackend;
  private readonly modelChoices: ModelChoices;
  private readonly fixed: CenterRow[] = [];
  private readonly dynamic = new Map<string, CenterRow>();
  private readonly extensions = new Map<
    string,
    { generation: number; rows: CenterRow[] }
  >();
  private readonly generations = new Map<string, number>();
  private readonly off: () => void;
  private current: readonly CenterRow[] = [];
  private refreshGeneration = 0;

  constructor(private readonly options: CenterCatalogOptions) {
    this.native = new NativeBackend({
      context: options.context,
      ...(options.agentDirectory
        ? { agentDirectory: options.agentDirectory }
        : {}),
      ...(options.hostSettings ? { hostSettings: options.hostSettings } : {}),
      ...(options.applyTheme ? { applyTheme: options.applyTheme } : {}),
    });
    this.keys = new KeybindingsBackend(
      options.context,
      options.keybindings,
      options.agentDirectory,
    );
    this.mcp = new McpBackend(options.context, options.agentDirectory);
    this.models = new ModelsBackend(options.context, options.agentDirectory);
    this.modelChoices = new ModelChoices(options.modelCatalog);
    this.off = options.registry.subscribe((change) => {
      if (change.type === "registered" || change.type === "withdrawn") {
        this.generations.set(
          change.extensionId,
          (this.generations.get(change.extensionId) ?? 0) + 1,
        );
        // Withdrawal/replacement must cancel stale drafts before any backing-file read finishes.
        this.publish(
          this.current.filter(
            (row) => this.dynamic.get(row.descriptor.id) === row,
          ),
        );
        try {
          this.options.onChange();
        } catch {
          /* Isolate host rendering. */
        }
      }
    });
    for (const entry of this.native.descriptors.values()) {
      this.fixed.push({
        descriptor: searchable(entry),
        editorSuggestions: async (scope) => {
          let provider: string | undefined;
          if (entry.path[0] === "defaultModel") {
            const providerEntry = [...this.native.descriptors.values()].find(
              (candidate) =>
                candidate.path.length === 1 &&
                candidate.path[0] === "defaultProvider",
            );
            if (providerEntry) {
              const result = await this.read(scope, () =>
                this.native.read(
                  providerEntry.id,
                  scope,
                  this.operationContext(),
                ),
              );
              // Startup choices follow saved scope/inheritance, not a project's or CLI's active override.
              let configured =
                result.state === "available"
                  ? result.configured
                  : { present: false as const };
              if (
                scope === "project" &&
                result.state === "available" &&
                !configured.present
              ) {
                const inherited = await this.read("user", () =>
                  this.native.read(
                    providerEntry.id,
                    "user",
                    this.operationContext(),
                  ),
                );
                if (inherited.state === "available")
                  configured = inherited.configured;
              }
              if (configured.present && typeof configured.value === "string")
                provider = configured.value;
            }
          }
          return this.modelChoices.native(entry.path, provider);
        },
        read: (scope) =>
          this.read(scope, () =>
            this.native.read(entry.id, scope, this.operationContext()),
          ),
        write: (transaction) =>
          this.edit(() =>
            this.native.write(
              { ...transaction, descriptorId: entry.id },
              this.operationContext(),
            ),
          ),
        removeOverride: (transaction) =>
          this.edit(() =>
            transaction.operation === "remove-override"
              ? this.native.removeOverride(
                  { ...transaction, descriptorId: entry.id },
                  this.operationContext(),
                )
              : Promise.resolve(rejected("validation")),
          ),
      });
    }
    for (const entry of this.keys.descriptors) {
      const action = entry.path[0] as string;
      this.fixed.push({
        descriptor: searchable(entry),
        keyCapture: true,
        warnings: async (transaction) =>
          transaction.operation === "set" && !this.session.signal.aborted
            ? (await this.keys.warnings(action, transaction.value)).map(
                (warning) => `${warning.otherAction}: ${warning.message}`,
              )
            : [],
        read: (scope) =>
          this.read(scope, () => this.keys.readAction(action, scope)),
        write: (transaction) =>
          this.edit(() =>
            transaction.operation === "set"
              ? this.keys.writeAction(
                  action,
                  transaction.scope,
                  transaction.expectedRevision,
                  transaction.value,
                )
              : Promise.resolve(rejected("validation")),
          ),
        removeOverride: (transaction) =>
          this.edit(() =>
            this.keys.removeOverride(
              action,
              transaction.scope,
              transaction.expectedRevision,
            ),
          ),
      });
    }
    this.fixed.push({
      descriptor: searchable(
        descriptor(
          "mcp:autoEnableCodemode",
          "MCP",
          ["autoEnableCodemode"],
          "Automatically enable codemode",
          { kind: "boolean" },
        ),
      ),
      read: (scope) =>
        this.read(scope, () =>
          this.mcp.readRootOption("autoEnableCodemode", scope),
        ),
      write: (transaction) =>
        this.edit(() =>
          transaction.operation === "set"
            ? this.mcp.writeRootOption(
                "autoEnableCodemode",
                transaction.scope,
                transaction.expectedRevision,
                transaction.value,
              )
            : Promise.resolve(rejected("validation")),
        ),
      removeOverride: (transaction) =>
        this.edit(() =>
          this.mcp.removeRootOption(
            "autoEnableCodemode",
            transaction.scope,
            transaction.expectedRevision,
          ),
        ),
    });
    this.fixed.push(this.createRow("mcp"), this.createRow("models"));
    this.publish([]);
  }

  rows(): readonly CenterRow[] {
    return this.current;
  }
  private operationContext() {
    return { signal: this.session.signal };
  }
  private async read(
    scope: Scope,
    operation: () => Promise<ScopedReadResult>,
  ): Promise<ScopedReadResult> {
    if (this.session.signal.aborted)
      return {
        state: "unavailable",
        scope,
        reason: "Settings session is closed.",
      };
    const result = await operation();
    return this.session.signal.aborted
      ? { state: "unavailable", scope, reason: "Settings session is closed." }
      : result;
  }
  private async edit(
    operation: () => Promise<EditResult>,
  ): Promise<EditResult> {
    if (this.session.signal.aborted) return rejected("unavailable");
    const result = await operation();
    if (result.state === "persisted" && !this.session.signal.aborted) {
      // Discovery failure must not turn acknowledged persistence into a failed save.
      try {
        await this.refresh();
      } catch {
        /* The next explicit refresh retries discovery. */
      }
    }
    return result;
  }

  /** Controller has no warning surface: the host may call this before committing a key draft. */
  async keybindingWarnings(
    descriptorId: string,
    value: JsonValue,
  ): Promise<readonly ConflictWarning[]> {
    const entry = this.keys.descriptors.find(
      (candidate) => candidate.id === descriptorId,
    );
    return entry && !this.session.signal.aborted
      ? this.keys.warnings(entry.path[0] as string, value)
      : [];
  }

  private async configuration(kind: "mcp" | "models", scope: Scope) {
    const location = resolveConfigurationPath(
      kind,
      scope,
      this.options.context,
      this.options.agentDirectory,
    );
    const result = await readConfiguration(location, kind === "models");
    const after = resolveConfigurationPath(
      kind,
      scope,
      this.options.context,
      this.options.agentDirectory,
    );
    if (after.state === "unavailable")
      return { state: "unavailable" as const, reason: after.reason };
    if (
      result.state === "available" &&
      (kind === "mcp"
        ? !validateMcpConfiguration(result.value).valid
        : result.exists && !validateModelsConfiguration(result.value).valid)
    ) {
      return {
        state: "error" as const,
        message: "Configuration is invalid; repair the file before editing.",
      };
    }
    return result;
  }
  private createRow(kind: "mcp" | "models"): CenterRow {
    const isMcp = kind === "mcp";
    const page = isMcp ? "MCP" : "Models";
    const noun = isMcp ? "server" : "provider";
    const path = isMcp ? "mcpServers" : "providers";
    const schema = createSchema(
      isMcp ? MCP_SERVER_SCHEMA : PROVIDER_SCHEMA,
      noun,
    );
    const entry = searchable(
      descriptor(
        `${kind}:add-${noun}`,
        page,
        [path],
        `Add ${noun}`,
        schema,
        isMcp ? scopes : ["user"],
      ),
    );
    // The editor wrapper is not persisted. Index the actual backing definition's paths too.
    entry.searchTerms = [
      ...(entry.searchTerms ?? []),
      ...(searchable(
        descriptor(
          "schema",
          page,
          [path, "*"],
          noun,
          isMcp ? MCP_SERVER_SCHEMA : PROVIDER_SCHEMA,
        ),
      ).searchTerms ?? []),
    ];
    return {
      descriptor: entry,
      ...(isMcp
        ? {}
        : {
            initialField: "name",
            editorSuggestions: async () =>
              this.modelChoices.provider(undefined, true),
          }),
      initialValue: { name: "", definition: {} },
      read: (scope) =>
        this.read(scope, async () => {
          const root = await this.configuration(kind, scope);
          return root.state === "available"
            ? absent(scope)
            : root.state === "unavailable"
              ? { state: "unavailable", scope, reason: root.reason }
              : { state: "error", scope, message: root.message };
        }),
      write: (transaction) =>
        this.edit(async () => {
          if (
            transaction.operation !== "set" ||
            !validateValue(schema, transaction.value).valid
          )
            return rejected("validation");
          if (transaction.expectedRevision !== absentRevision)
            return rejected("conflict");
          const wrapper = transaction.value as {
            name: string;
            definition: JsonValue;
          };
          // Never replace the absent revision with a freshly read destination revision.
          const result = isMcp
            ? await this.mcp.writeServer(
                wrapper.name,
                transaction.scope,
                transaction.expectedRevision,
                wrapper.definition,
              )
            : await this.models.writeProvider(
                wrapper.name,
                wrapper.definition,
                transaction.expectedRevision,
                transaction.scope,
              );
          return result.state === "persisted"
            ? { ...result, read: absent(transaction.scope) }
            : result;
        }),
    };
  }

  private namedRows(kind: "mcp" | "models", name: string): CenterRow[] {
    const isMcp = kind === "mcp";
    const id = identity(kind, name);
    const page = isMcp ? "MCP" : "Models";
    const path = [isMcp ? "mcpServers" : "providers", metadata(name)];
    const supported = isMcp ? scopes : (["user"] as const);
    const read = (scope: Scope) =>
      this.read(scope, () =>
        isMcp
          ? this.mcp.readDraft(name, scope)
          : this.models.readProvider(name, scope),
      );
    const remove = (scope: Scope, revision: string) =>
      this.edit(() =>
        isMcp
          ? this.mcp.deleteServer(name, scope, revision)
          : this.models.deleteProvider(name, revision, scope),
      );
    return [
      this.cached(id, () => ({
        descriptor: searchable(
          descriptor(
            id,
            page,
            path,
            `${isMcp ? "Server" : "Provider"}: ${metadata(name)}`,
            isMcp ? MCP_SERVER_SCHEMA : PROVIDER_SCHEMA,
            supported,
          ),
          `${path[0]}.*`,
        ),
        read,
        ...(isMcp
          ? {}
          : {
              editorSuggestions: async () => this.modelChoices.provider(name),
            }),
        write: (transaction) =>
          this.edit(() =>
            transaction.operation !== "set"
              ? Promise.resolve(rejected("validation"))
              : isMcp
                ? this.mcp.writeServer(
                    name,
                    transaction.scope,
                    transaction.expectedRevision,
                    transaction.value,
                  )
                : this.models.writeProvider(
                    name,
                    transaction.value,
                    transaction.expectedRevision,
                    transaction.scope,
                  ),
          ),
        delete: remove,
        ...(isMcp
          ? {
              removeOverride: (transaction: EditTransaction) =>
                this.edit(() =>
                  this.mcp.removeOverride(
                    name,
                    transaction.scope,
                    transaction.expectedRevision,
                  ),
                ),
            }
          : {}),
      })),
      this.cached(`${id}:rename`, () => ({
        descriptor: searchable(
          descriptor(
            `${id}:rename`,
            page,
            path,
            `Rename ${isMcp ? "server" : "provider"}: ${metadata(name)}`,
            named,
            supported,
          ),
          `${path[0]}.*`,
        ),
        read: async (scope) => scalar(await read(scope), name),
        ...(isMcp
          ? {}
          : {
              editorSuggestions: async () =>
                this.modelChoices.native(["defaultProvider"]),
            }),
        write: (transaction) =>
          this.edit(async () => {
            if (
              transaction.operation !== "set" ||
              typeof transaction.value !== "string"
            )
              return rejected("validation");
            const result = isMcp
              ? await this.mcp.renameServer(
                  name,
                  transaction.scope,
                  transaction.expectedRevision,
                  transaction.value,
                )
              : await this.models.renameProvider(
                  name,
                  transaction.value,
                  transaction.expectedRevision,
                  transaction.scope,
                );
            return scalarResult(result, transaction.value);
          }),
      })),
    ];
  }
  private cached(id: string, make: () => CenterRow): CenterRow {
    let row = this.dynamic.get(id);
    if (!row) {
      row = make();
      this.dynamic.set(id, row);
    }
    return row;
  }

  private extensionRows(): CenterRow[] {
    const active = new Set<string>();
    const result: CenterRow[] = [];
    for (const extension of this.options.registry.list()) {
      active.add(extension.extensionId);
      const generation = this.generations.get(extension.extensionId) ?? 0;
      let cached = this.extensions.get(extension.extensionId);
      if (!cached || cached.generation !== generation) {
        const operations = this.options.registry.operations(
          extension.extensionId,
        );
        if (!operations) continue;
        cached = {
          generation,
          rows: extension.descriptors.map((entry) =>
            this.extensionRow(
              entry,
              operations,
              extension.supportsRemoveOverride,
            ),
          ),
        };
        this.extensions.set(extension.extensionId, cached);
      }
      result.push(...cached.rows);
    }
    for (const id of this.extensions.keys())
      if (!active.has(id)) this.extensions.delete(id);
    return result;
  }
  private extensionRow(
    entry: SettingDescriptor,
    operations: SettingsOperations,
    canRemove: boolean,
  ): CenterRow {
    const convert = (transaction: EditTransaction): EditTransaction => ({
      ...transaction,
      descriptorId: entry.id,
    });
    const removeOverride = operations.removeOverride?.bind(operations);
    return {
      descriptor: searchable(entry),
      read: (scope) =>
        this.read(scope, () =>
          operations.read(entry.id, scope, this.operationContext()),
        ),
      write: (transaction) =>
        this.edit(() =>
          operations.write(convert(transaction), this.operationContext()),
        ),
      ...(canRemove && removeOverride
        ? {
            removeOverride: (transaction: EditTransaction) =>
              this.edit(() =>
                transaction.operation !== "remove-override"
                  ? Promise.resolve(rejected("validation"))
                  : removeOverride(
                      { ...transaction, descriptorId: entry.id },
                      this.operationContext(),
                    ),
              ),
          }
        : {}),
    };
  }

  private publish(dynamic: CenterRow[]): void {
    this.current = Object.freeze([
      ...this.fixed,
      ...dynamic,
      ...this.extensionRows(),
    ]);
  }
  async refresh(): Promise<void> {
    if (this.session.signal.aborted) return;
    const generation = ++this.refreshGeneration;
    const [userMcp, projectMcp, models] = await Promise.all([
      this.configuration("mcp", "user"),
      this.configuration("mcp", "project"),
      this.configuration("models", "user"),
    ]);
    if (this.session.signal.aborted || generation !== this.refreshGeneration)
      return;
    const names = (value: JsonValue | undefined): string[] =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)
        : [];
    const servers = new Set([
      ...(userMcp.state === "available" ? names(userMcp.value.mcpServers) : []),
      ...(projectMcp.state === "available" &&
      this.options.context.isProjectTrusted()
        ? names(projectMcp.value.mcpServers)
        : []),
    ]);
    this.modelChoices.setConfigured(
      models.state === "available" ? models.value : undefined,
    );
    const providers =
      models.state === "available" ? names(models.value.providers) : [];
    const dynamic = [
      ...[...servers].sort().flatMap((name) => this.namedRows("mcp", name)),
      ...providers.sort().flatMap((name) => this.namedRows("models", name)),
    ];
    const active = new Set(dynamic.map((row) => row.descriptor.id));
    for (const id of this.dynamic.keys())
      if (!active.has(id)) this.dynamic.delete(id);
    this.publish(dynamic);
    try {
      this.options.onChange();
    } catch {
      /* Isolate host rendering from persistence. */
    }
  }
  dispose(): void {
    if (this.session.signal.aborted) return;
    this.session.abort();
    this.refreshGeneration++;
    this.off();
    this.dynamic.clear();
    this.extensions.clear();
    this.current = [];
  }
}
