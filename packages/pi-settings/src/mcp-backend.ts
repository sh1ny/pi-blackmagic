import { readConfiguration } from "./configuration-read.ts";
import type {
  EditResult,
  JsonValue,
  Revision,
  Scope,
  ScopedReadResult,
  ValueSchema,
} from "./contracts.ts";
import {
  MCP_SERVER_SCHEMA,
  validateMcpConfiguration,
  validateMcpRootOption,
  validateMcpServer,
  validateMcpServerName,
} from "./mcp-schema.ts";
import {
  type ConfigurationPath,
  type ProjectContext,
  resolveConfigurationPath,
} from "./paths.ts";
import {
  entryRevision,
  persistEntry,
  readEntry,
  type SemanticMutation,
  type EntrySnapshot,
} from "./persistence.ts";
import { maskValue, restoreMasked, safeDiagnostic } from "./redaction.ts";

type AvailableRead = Extract<ScopedReadResult, { state: "available" }>;
const rootSchema: ValueSchema = { kind: "boolean" };
const rejected = (
  reason: "validation" | "conflict" | "unavailable",
  message: string,
): EditResult => ({ state: "rejected", reason, message });
const serverPath = (name: string) => ["mcpServers", name];
// Pi evaluates wildcard tool exposure in insertion order: reordering is a semantic edit.
const mcpRevision = (entry: EntrySnapshot) =>
  entryRevision(entry, [["toolExposure"]]);
function maskedRead(
  read: ScopedReadResult,
  schema: ValueSchema,
): ScopedReadResult {
  if (read.state !== "available") return read;
  const mask = (value: JsonValue) =>
    maskValue(value, { sensitivity: "public", schema });
  return {
    ...read,
    configured: read.configured.present
      ? { present: true, value: mask(read.configured.value) }
      : read.configured,
    effective: read.effective.known
      ? { known: true, value: mask(read.effective.value) }
      : read.effective,
  };
}

/** Storage only, never an MCP client. Raw reads are for internal backend composition, not UI. */
export class McpBackend {
  constructor(
    private readonly context: ProjectContext,
    private readonly agentDirectory?: () => string,
  ) {}

  private location(scope: Scope): ConfigurationPath {
    return resolveConfigurationPath(
      "mcp",
      scope,
      this.context,
      this.agentDirectory,
    );
  }

  private async load(scope: Scope) {
    const result = await readConfiguration(this.location(scope));
    if (
      result.state === "available" &&
      !validateMcpConfiguration(result.value).valid
    )
      return {
        state: "error" as const,
        message:
          "MCP configuration is invalid; repair the file before editing.",
      };
    // Trust may have been revoked during filesystem I/O. Discard that read completely.
    const location = this.location(scope);
    return location.state === "unavailable"
      ? { state: "unavailable" as const, reason: location.reason }
      : result;
  }

  private async read(
    path: readonly string[],
    scope: Scope,
    defaultValue?: JsonValue,
  ): Promise<ScopedReadResult> {
    try {
      const selected = await this.load(scope);
      if (selected.state !== "available")
        return selected.state === "unavailable"
          ? { state: "unavailable", scope, reason: selected.reason }
          : { state: "error", scope, message: selected.message };
      const other = await this.load(scope === "user" ? "project" : "user");
      if (this.location(scope).state === "unavailable")
        return {
          state: "unavailable",
          scope,
          reason: "Project configuration access is no longer available.",
        };
      const configured = readEntry(selected.value, path);
      const user = scope === "user" ? selected : other;
      const project = scope === "project" ? selected : other;
      const userEntry =
        user.state === "available"
          ? readEntry(user.value, path)
          : { present: false as const };
      const projectEntry =
        project.state === "available"
          ? readEntry(project.value, path)
          : { present: false as const };
      const effectiveEntry = projectEntry.present ? projectEntry : userEntry;
      const source = projectEntry.present
        ? "project"
        : userEntry.present
          ? "user"
          : "default";
      // Never invent a known effective value when a higher-priority file is broken.
      const known =
        project.state !== "error" &&
        (projectEntry.present || user.state !== "error");
      return {
        state: "available",
        scope,
        configured,
        revision: mcpRevision(configured),
        effective:
          known && effectiveEntry.present
            ? { known: true, value: effectiveEntry.value }
            : known && defaultValue !== undefined
              ? { known: true, value: defaultValue }
              : { known: false },
        provenance: { source, sessionState: "unknown" },
      };
    } catch (error) {
      return { state: "error", scope, message: safeDiagnostic(error, "read") };
    }
  }

  /** Internal raw storage read. Use readDraft for any editor, preview, or ordinary UI. */
  readServer(name: string, scope: Scope): Promise<ScopedReadResult> {
    if (!validateMcpServerName(name).valid)
      return Promise.resolve({
        state: "error",
        scope,
        message: "Invalid MCP server name.",
      });
    return this.read(serverPath(name), scope);
  }
  async readDraft(name: string, scope: Scope): Promise<ScopedReadResult> {
    return maskedRead(await this.readServer(name, scope), MCP_SERVER_SCHEMA);
  }
  readRootOption(name: string, scope: Scope): Promise<ScopedReadResult> {
    if (name !== "autoEnableCodemode")
      return Promise.resolve({
        state: "error",
        scope,
        message: "Unsupported MCP root option.",
      });
    return this.read([name], scope, true);
  }

  /** Submitting a complete entry is the only operation that saves; no draft files exist. */
  writeServer(
    name: string,
    scope: Scope,
    revision: Revision,
    value: JsonValue,
  ): Promise<EditResult> {
    return this.editServer(name, scope, revision, value);
  }
  renameServer(
    name: string,
    scope: Scope,
    revision: Revision,
    destination: string,
    value?: JsonValue,
  ): Promise<EditResult> {
    return this.editServer(name, scope, revision, value, destination);
  }
  private async editServer(
    name: string,
    scope: Scope,
    revision: Revision,
    draft?: JsonValue,
    destination?: string,
  ): Promise<EditResult> {
    try {
      if (
        !validateMcpServerName(name).valid ||
        (destination !== undefined && !validateMcpServerName(destination).valid)
      )
        return rejected("validation", "Invalid MCP server name.");
      const baseline = await this.readServer(name, scope);
      if (baseline.state !== "available")
        return baseline.state === "unavailable"
          ? rejected("unavailable", baseline.reason)
          : { state: "failed", message: baseline.message };
      if (baseline.revision !== revision)
        return rejected(
          "conflict",
          "This entry changed externally; refresh and re-edit.",
        );
      if (destination !== undefined && !baseline.configured.present)
        return rejected(
          "validation",
          "Only a configured server in the selected scope can be renamed.",
        );
      const original = baseline.configured.present
        ? baseline.configured.value
        : baseline.effective.known
          ? baseline.effective.value
          : null;
      const value =
        draft === undefined ? original : restoreMasked(draft, original);
      if (!validateMcpServer(destination ?? name, value).valid)
        return rejected("validation", "MCP server validation failed.");
      const change: SemanticMutation["change"] =
        destination === undefined
          ? { operation: "set", value }
          : { operation: "rename", destination, value };
      return await this.persist(
        scope,
        { path: serverPath(name), expectedRevision: revision, change },
        MCP_SERVER_SCHEMA,
        (entry) => validateMcpServer(destination ?? name, entry),
      );
    } catch (error) {
      return rejected("validation", safeDiagnostic(error, "validation"));
    }
  }
  deleteServer(
    name: string,
    scope: Scope,
    revision: Revision,
  ): Promise<EditResult> {
    if (!validateMcpServerName(name).valid)
      return Promise.resolve(
        rejected("validation", "Invalid MCP server name."),
      );
    return this.persist(
      scope,
      {
        path: serverPath(name),
        expectedRevision: revision,
        change: { operation: "remove" },
      },
      MCP_SERVER_SCHEMA,
      (entry) => validateMcpServer(name, entry),
    );
  }
  /** Removal reveals the inherited user entry rather than disabling it. */
  removeOverride(
    name: string,
    scope: Scope,
    revision: Revision,
  ): Promise<EditResult> {
    return this.deleteServer(name, scope, revision);
  }
  writeRootOption(
    name: string,
    scope: Scope,
    revision: Revision,
    value: JsonValue,
  ): Promise<EditResult> {
    if (!validateMcpRootOption(name, value).valid)
      return Promise.resolve(
        rejected("validation", "MCP root option validation failed."),
      );
    return this.persist(
      scope,
      {
        path: [name],
        expectedRevision: revision,
        change: { operation: "set", value },
      },
      rootSchema,
      (entry) => validateMcpRootOption(name, entry),
    );
  }
  removeRootOption(
    name: string,
    scope: Scope,
    revision: Revision,
  ): Promise<EditResult> {
    if (name !== "autoEnableCodemode")
      return Promise.resolve(
        rejected("validation", "Unsupported MCP root option."),
      );
    return this.persist(
      scope,
      {
        path: [name],
        expectedRevision: revision,
        change: { operation: "remove" },
      },
      rootSchema,
      (entry) => validateMcpRootOption(name, entry),
    );
  }

  private async persist(
    scope: Scope,
    mutation: SemanticMutation,
    schema: ValueSchema,
    validateEntry: (value: JsonValue) => ReturnType<typeof validateMcpServer>,
  ): Promise<EditResult> {
    try {
      const current = await this.load(scope);
      if (current.state !== "available")
        return current.state === "unavailable"
          ? rejected("unavailable", current.reason)
          : { state: "failed", message: current.message };
      const result = await persistEntry({
        location: () => this.location(scope),
        mutation,
        validateEntry,
        validateConfiguration: validateMcpConfiguration,
        revisionOf: mcpRevision,
      });
      if (result.state !== "persisted") return result;
      const path =
        mutation.change.operation === "rename"
          ? [...mutation.path.slice(0, -1), mutation.change.destination]
          : mutation.path;
      const refreshed = await this.read(
        path,
        scope,
        path.length === 1 ? true : undefined,
      );
      // A later failed refresh must not turn an acknowledged save into a fictitious failure.
      const fallback: AvailableRead = {
        state: "available",
        scope,
        configured: result.entry,
        effective: { known: false },
        revision: result.revision,
        provenance: {
          source: result.entry.present ? scope : "default",
          sessionState: "unknown",
        },
      };
      const read: AvailableRead =
        refreshed.state === "available"
          ? {
              ...refreshed,
              configured: result.entry,
              revision: result.revision,
            }
          : fallback;
      return {
        state: "persisted",
        read: maskedRead(read, schema) as AvailableRead,
        activation: { state: "required", requirement: "reload" },
      };
    } catch (error) {
      return { state: "failed", message: safeDiagnostic(error, "write") };
    }
  }
}
