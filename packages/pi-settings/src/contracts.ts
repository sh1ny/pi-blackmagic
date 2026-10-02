/** Shared, storage-independent contracts for the settings catalog and providers. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Scope = "user" | "project";
export type Sensitivity = "public" | "masked";
export type Revision = string;
export type ActivationRequirement = "immediate" | "reload" | "restart";

export type ActivationResult =
  | { state: "active" }
  | { state: "required"; requirement: "reload" | "restart" }
  | { state: "failed"; requirement: ActivationRequirement; message: string };

export type ValueSchema =
  | { kind: "json" }
  | { kind: "boolean" }
  | { kind: "text"; minLength?: number; maxLength?: number }
  | {
      kind: "number";
      minimum?: number;
      maximum?: number;
      exclusiveMinimum?: number;
      integer?: boolean;
    }
  | { kind: "choice"; values: readonly (string | number | boolean | null)[] }
  | { kind: "union"; variants: readonly ValueSchema[] }
  | { kind: "list"; item: ValueSchema; minItems?: number; maxItems?: number }
  | { kind: "map"; value: ValueSchema }
  | {
      kind: "structured";
      fields: Readonly<Record<string, FieldSchema>>;
      preserveUnknown: boolean;
    };

export interface FieldSchema {
  schema: ValueSchema;
  required: boolean;
  sensitivity: Sensitivity;
  description: string;
}

export interface SettingDescriptor {
  id: string;
  providerId: string;
  pageId: string;
  path: readonly string[];
  label: string;
  description: string;
  sourceLabel: string;
  schema: ValueSchema;
  scopes: readonly Scope[];
  sensitivity: Sensitivity;
  /** Value sensitivity is independent of whether descriptor metadata is safe to index. */
  metadataSensitivity?: Sensitivity;
  /** Public schema/path keywords only, never configured values; separate from concise display help. */
  searchTerms?: readonly string[];
  activation: ActivationRequirement;
}

export interface Provenance {
  source: "default" | Scope | "host-override";
  /** A separate effective value is not necessarily the current host session value. */
  sessionState: "known" | "unknown";
}

export type ScopedReadResult =
  | {
      state: "available";
      scope: Scope;
      configured: { present: false } | { present: true; value: JsonValue };
      effective: { known: false } | { known: true; value: JsonValue };
      revision: Revision;
      provenance: Provenance;
    }
  | { state: "unavailable"; scope: Scope; reason: string }
  | { state: "error"; scope: Scope; message: string };

/** Masked fields distinguish retention from deliberate replacement, including empty input. */
export type SensitiveEdit =
  | { operation: "retain" }
  | { operation: "replace"; value: JsonValue };

export type EditTransaction = {
  descriptorId: string;
  scope: Scope;
  expectedRevision: Revision;
} & (
  | { operation: "set"; value: JsonValue }
  | { operation: "remove-override" }
  | { operation: "rename"; destination: string; value: JsonValue }
);

export type ValidationResult =
  | { valid: true }
  | { valid: false; message: string };

export type EditResult =
  | {
      state: "persisted";
      read: Extract<ScopedReadResult, { state: "available" }>;
      activation: ActivationResult;
    }
  | {
      state: "rejected";
      reason: "validation" | "conflict" | "unavailable";
      message: string;
    }
  | { state: "failed"; message: string }
  | { state: "indeterminate"; requiresReadBack: true; message: string };

export interface OperationContext {
  signal: AbortSignal;
}

/** Providers own storage. Callbacks must return safe diagnostics, not raw exceptions. */
export interface SettingsOperations {
  read(
    descriptorId: string,
    scope: Scope,
    context: OperationContext,
  ): Promise<ScopedReadResult>;
  validate(
    transaction: EditTransaction,
    context: OperationContext,
  ): Promise<ValidationResult>;
  write(
    transaction: EditTransaction,
    context: OperationContext,
  ): Promise<EditResult>;
  removeOverride?(
    transaction: Extract<EditTransaction, { operation: "remove-override" }>,
    context: OperationContext,
  ): Promise<EditResult>;
}
