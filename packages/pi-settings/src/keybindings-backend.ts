import { readConfiguration } from "./configuration-read.ts";
import type {
  EditResult,
  JsonValue,
  Revision,
  Scope,
  ScopedReadResult,
} from "./contracts.ts";
import {
  assignmentWarnings,
  validateAssignments,
} from "./keybindings-validation.ts";
import {
  defaultAssignments,
  KEYBINDING_ACTIONS,
  KEYBINDING_DESCRIPTORS,
} from "./keybindings-catalog.ts";
import { resolveConfigurationPath } from "./paths.ts";
import type { ProjectContext } from "./paths.ts";
import { entryRevision, persistEntry, readEntry } from "./persistence.ts";

export interface EffectiveKeybindings {
  getEffectiveConfig(): Record<string, string | readonly string[] | undefined>;
}

export class KeybindingsBackend {
  readonly descriptors = KEYBINDING_DESCRIPTORS;
  constructor(
    private readonly context: ProjectContext,
    private readonly host?: EffectiveKeybindings,
    private readonly agentDirectory?: () => string,
  ) {}

  async writeAction(
    action: string,
    scope: Scope,
    revision: Revision,
    value: JsonValue,
  ): Promise<EditResult> {
    const validation = validateAssignments(value);
    if (!validation.valid)
      return {
        state: "rejected",
        reason: "validation",
        message: validation.message,
      };
    return this.mutate(action, scope, revision, { operation: "set", value });
  }

  async removeOverride(
    action: string,
    scope: Scope,
    revision: Revision,
  ): Promise<EditResult> {
    return this.mutate(action, scope, revision, { operation: "remove" });
  }

  async warnings(action: string, value: JsonValue) {
    const location = resolveConfigurationPath(
      "keybindings",
      "user",
      this.context,
      this.agentDirectory,
    );
    const read = await readConfiguration(location);
    const assignments = Object.fromEntries(
      Object.entries(KEYBINDING_ACTIONS).map(([id]) => [
        id,
        read.state === "available" && Object.hasOwn(read.value, id)
          ? (read.value[id] as JsonValue)
          : defaultAssignments(id),
      ]),
    );
    return assignmentWarnings(action, value, assignments);
  }

  private async mutate(
    action: string,
    scope: Scope,
    revision: Revision,
    change: { operation: "set"; value: JsonValue } | { operation: "remove" },
  ): Promise<EditResult> {
    if (!Object.hasOwn(KEYBINDING_ACTIONS, action) || scope !== "user")
      return {
        state: "rejected",
        reason: "unavailable",
        message: "Keybindings support reviewed actions in user scope only.",
      };
    const result = await persistEntry({
      location: () =>
        resolveConfigurationPath(
          "keybindings",
          scope,
          this.context,
          this.agentDirectory,
        ),
      mutation: { path: [action], expectedRevision: revision, change },
      validateEntry: validateAssignments,
      validateConfiguration: (root) => {
        for (const [id, configured] of Object.entries(root)) {
          // Preserve historical/unknown syntax, including the documented baseline plus limitation.
          if (
            Object.hasOwn(KEYBINDING_ACTIONS, id) &&
            typeof configured !== "string" &&
            !(
              Array.isArray(configured) &&
              configured.every((key) => typeof key === "string")
            )
          )
            return {
              valid: false,
              message: "Invalid keybinding assignment shape.",
            };
        }
        return { valid: true };
      },
    });
    if (result.state !== "persisted") return result;
    const refreshed = await this.readAction(action, scope);
    const read: Extract<ScopedReadResult, { state: "available" }> =
      refreshed.state === "available"
        ? refreshed
        : {
            state: "available",
            scope,
            configured: result.entry,
            effective: { known: false },
            revision: result.revision,
            provenance: { source: scope, sessionState: "unknown" },
          };
    return {
      state: "persisted",
      read,
      activation: { state: "required", requirement: "reload" },
    };
  }

  async readAction(
    action: string,
    scope: Scope = "user",
  ): Promise<ScopedReadResult> {
    if (!Object.hasOwn(KEYBINDING_ACTIONS, action))
      return {
        state: "unavailable",
        scope,
        reason:
          "Unknown actions are preserved but not inferred as editable preferences.",
      };
    const location = resolveConfigurationPath(
      "keybindings",
      scope,
      this.context,
      this.agentDirectory,
    );
    if (location.state !== "available")
      return { state: "unavailable", scope, reason: location.reason };
    const read = await readConfiguration(location);
    if (read.state !== "available")
      return {
        state: "error",
        scope,
        message:
          read.state === "error"
            ? read.message
            : "Keybindings are unavailable.",
      };
    const configured = readEntry(read.value, [action]);
    const saved = configured.present
      ? configured.value
      : defaultAssignments(action);
    const runtime = this.host?.getEffectiveConfig();
    const active =
      runtime && Object.hasOwn(runtime, action) ? runtime[action] : undefined;
    const effective: JsonValue =
      active === undefined
        ? saved
        : typeof active === "string"
          ? active
          : [...active];
    const normalized = (value: JsonValue) =>
      JSON.stringify(typeof value === "string" ? [value] : value);
    const source =
      active !== undefined && normalized(effective) !== normalized(saved)
        ? "host-override"
        : configured.present
          ? "user"
          : "default";
    return {
      state: "available",
      scope,
      configured,
      effective: { known: true, value: effective },
      revision: entryRevision(configured),
      provenance: {
        source,
        sessionState: active === undefined ? "unknown" : "known",
      },
    };
  }
}
