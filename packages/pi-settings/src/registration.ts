import type { SettingDescriptor, SettingsOperations } from "./contracts.ts";

export type {
  ActivationResult,
  EditResult,
  EditTransaction,
  FieldSchema,
  JsonValue,
  OperationContext,
  Scope,
  ScopedReadResult,
  SettingDescriptor,
  SettingsOperations,
  ValidationResult,
  ValueSchema,
} from "./contracts.ts";

export const SETTINGS_PROTOCOL_VERSION = 1 as const;
export const SETTINGS_CHANNELS = Object.freeze({
  request: "pi-settings:v1:request",
  register: "pi-settings:v1:register",
  unregister: "pi-settings:v1:unregister",
});

/** Structural subset of the host event bus; no host runtime import is necessary. */
export interface SettingsEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Identity is compared by reference (or symbol identity), never serialized. */
export type SettingsOwner = object | symbol;
export interface SettingsPage {
  id: string;
  label: string;
  description: string;
}
export interface SettingsRequest {
  protocolVersion: typeof SETTINGS_PROTOCOL_VERSION;
}
export interface SettingsRegistration {
  protocolVersion: typeof SETTINGS_PROTOCOL_VERSION;
  extensionId: string;
  owner: SettingsOwner;
  displayName: string;
  pages: readonly SettingsPage[];
  descriptors: readonly SettingDescriptor[];
  operations: SettingsOperations;
}
export interface SettingsWithdrawal {
  protocolVersion: typeof SETTINGS_PROTOCOL_VERSION;
  extensionId: string;
  owner: SettingsOwner;
}

/** Announce and answer discovery even when no settings center is installed. */
export function registerSettings(
  bus: SettingsEventBus,
  payload: SettingsRegistration,
): () => void {
  let disposed = false;
  // Subscribe first: a consumer may request discovery while handling the announcement.
  const off = bus.on(SETTINGS_CHANNELS.request, (request) => {
    if (
      !disposed &&
      typeof request === "object" &&
      request !== null &&
      "protocolVersion" in request &&
      request.protocolVersion === SETTINGS_PROTOCOL_VERSION
    )
      bus.emit(SETTINGS_CHANNELS.register, payload);
  });
  bus.emit(SETTINGS_CHANNELS.register, payload);
  return () => {
    if (disposed) return;
    disposed = true;
    off();
    bus.emit(SETTINGS_CHANNELS.unregister, {
      protocolVersion: SETTINGS_PROTOCOL_VERSION,
      extensionId: payload.extensionId,
      owner: payload.owner,
    } satisfies SettingsWithdrawal);
  };
}
