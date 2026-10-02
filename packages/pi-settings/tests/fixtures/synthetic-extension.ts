// The fixture consumes the registration subpath source only, not the extension entrypoint.
import {
  registerSettings,
  type EditResult,
  type EditTransaction,
  type JsonValue,
  type Scope,
  type ScopedReadResult,
  type SettingsEventBus,
  type SettingsOperations,
  type SettingsRegistration,
} from "../../src/registration.ts";

export class SyntheticBus implements SettingsEventBus {
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  readonly emitted: { channel: string; data: unknown }[] = [];
  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const listener of [...(this.listeners.get(channel) ?? [])])
      listener(data);
  }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set();
    this.listeners.set(channel, listeners);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }
  count(channel?: string): number {
    return channel
      ? (this.listeners.get(channel)?.size ?? 0)
      : [...this.listeners.values()].reduce(
          (sum, listeners) => sum + listeners.size,
          0,
        );
  }
}

export function syntheticExtension(
  bus?: SettingsEventBus,
  extensionId = "synthetic",
) {
  let value: JsonValue = false;
  let revision = 0;
  let ordinaryCalls = 0;
  const calls = { read: 0, validate: 0, write: 0, remove: 0 };
  const read = (
    scope: Scope,
  ): Extract<ScopedReadResult, { state: "available" }> => ({
    state: "available",
    scope,
    configured: { present: true, value },
    effective: { known: true, value },
    revision: String(revision),
    provenance: { source: scope, sessionState: "unknown" },
  });
  const operations: SettingsOperations = {
    async read(_id, scope) {
      calls.read++;
      return read(scope);
    },
    async validate() {
      calls.validate++;
      return { valid: true };
    },
    async write(transaction) {
      calls.write++;
      if (transaction.operation !== "remove-override")
        value = transaction.value;
      revision++;
      return {
        state: "persisted",
        read: read(transaction.scope),
        activation: { state: "required", requirement: "reload" },
      };
    },
    async removeOverride(transaction) {
      calls.remove++;
      value = false;
      revision++;
      return {
        state: "persisted",
        read: read(transaction.scope),
        activation: { state: "active" },
      };
    },
  };
  const payload: SettingsRegistration = {
    protocolVersion: 1,
    extensionId,
    owner: {},
    displayName: "Synthetic tools",
    pages: [
      {
        id: "advanced",
        label: "Advanced behavior",
        description: "Specialized settings",
      },
    ],
    descriptors: [
      {
        id: `${extensionId}.advanced.enabled`,
        providerId: extensionId,
        pageId: "advanced",
        path: ["enabled"],
        label: "Enabled",
        description: "Enable synthetic behavior",
        sourceLabel: "Synthetic",
        schema: { kind: "boolean" },
        scopes: ["user"],
        sensitivity: "public",
        activation: "reload",
      },
    ],
    operations,
  };
  const cleanup = bus ? registerSettings(bus, payload) : () => {};
  return {
    payload,
    calls,
    cleanup,
    ordinary() {
      ordinaryCalls++;
      return `ordinary-${ordinaryCalls}`;
    },
    read,
  };
}

export const transaction = (
  extensionId = "synthetic",
): Extract<EditTransaction, { operation: "set" }> => ({
  descriptorId: `${extensionId}.advanced.enabled`,
  scope: "user",
  expectedRevision: "0",
  operation: "set",
  value: true,
});
export function persisted(scope: Scope = "user"): EditResult {
  return {
    state: "persisted",
    read: {
      state: "available",
      scope,
      configured: { present: true, value: true },
      effective: { known: true, value: true },
      revision: "1",
      provenance: { source: scope, sessionState: "unknown" },
    },
    activation: { state: "required", requirement: "reload" },
  };
}
