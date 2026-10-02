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
import { isMasked, maskValue, restoreMasked } from "./redaction.ts";
import {
  SETTINGS_CHANNELS,
  SETTINGS_PROTOCOL_VERSION,
  type SettingsEventBus,
  type SettingsOwner,
  type SettingsPage,
  type SettingsRegistration,
} from "./registration.ts";
import { validateValue } from "./validation.ts";

/** Each callback has this deadline; cancellation cannot roll back trusted code. */
export const SETTINGS_OPERATION_DEADLINE_MS = 10_000;
export interface RegistryScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface RegistryOptions {
  scheduler?: RegistryScheduler;
  /** Safe registration warnings, including synchronous startup discovery. */
  onDiagnostic?: (safeMessage: string) => void;
}
export interface RegisteredExtension {
  extensionId: string;
  displayName: string;
  tab: "Extensions";
  /** Derived from the provider callbacks, not an untrusted advertised capability. */
  supportsRemoveOverride: boolean;
  pages: readonly SettingsPage[];
  descriptors: readonly SettingDescriptor[];
}
export type RegistryChange =
  | { type: "registered"; extensionId: string }
  | { type: "withdrawn"; extensionId: string; descriptorIds: readonly string[] }
  | { type: "diagnostic"; message: string }
  | {
      type: "operation";
      extensionId: string;
      descriptorId: string;
      scope: Scope;
      current: boolean;
      state: EditResult["state"];
    };

interface ReadBack {
  id: string;
  scope: Scope;
  read: SettingsOperations["read"];
}
interface Lane {
  busy: boolean;
  pending: boolean;
  epoch: number;
  readBack: Map<string, ReadBack>;
}
type AvailableRead = Extract<ScopedReadResult, { state: "available" }>;
interface Provider {
  owner: SettingsOwner;
  catalog: RegisteredExtension;
  fingerprint: string;
  operations: SettingsOperations;
  originalOperations: SettingsOperations;
  originalReceiver: SettingsOperations;
  rawReads: Map<string, AvailableRead>;
  lane: Lane;
  active: boolean;
}
type Invocation<T> =
  | { state: "returned"; value: T }
  | { state: "threw" | "timeout" | "cancelled" };
const realScheduler: RegistryScheduler = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const unavailable = "Extension setting is unavailable.";
const failed =
  "Extension operation failed. Provider diagnostics were withheld.";
const timedOut = "Extension operation exceeded the 10-second deadline.";
const uncertain =
  "Persistence is indeterminate. Read back after the prior write settles before retrying.";

/** Registration-only catalog. No filesystem, native backend, host runtime, or credential discovery. */
export class SettingsRegistry {
  private providers = new Map<string, Provider>();
  private lanes = new Map<string, Lane>();
  private listeners = new Set<(change: RegistryChange) => void>();
  private controllers = new Set<AbortController>();
  private off: (() => void)[];
  private disposed = false;
  private activeEdits = 0;
  private scheduler: RegistryScheduler;
  private onDiagnostic: RegistryOptions["onDiagnostic"];

  constructor(
    private bus: SettingsEventBus,
    options: RegistryOptions = {},
  ) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.onDiagnostic = options.onDiagnostic;
    // Both listeners exist before synchronous request responders can announce.
    this.off = [
      bus.on(SETTINGS_CHANNELS.register, (payload) => this.accept(payload)),
      bus.on(SETTINGS_CHANNELS.unregister, (payload) => this.withdraw(payload)),
    ];
    this.discover();
  }

  discover(): void {
    if (!this.disposed)
      this.bus.emit(SETTINGS_CHANNELS.request, {
        protocolVersion: SETTINGS_PROTOCOL_VERSION,
      });
  }

  /** Call on every settings interaction opening; repeated responses do not duplicate rows. */
  open(): void {
    this.discover();
  }

  list(): RegisteredExtension[] {
    return [...this.providers.values()].map((provider) =>
      structuredClone(provider.catalog),
    );
  }

  catalog(): SettingDescriptor[] {
    return this.list().flatMap((provider) => [...provider.descriptors]);
  }

  subscribe(listener: (change: RegistryChange) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Captures a generation. Replaced/withdrawn handles cannot dispatch new operations. */
  operations(extensionId: string): SettingsOperations | undefined {
    const provider = this.providers.get(extensionId);
    if (!provider) return undefined;
    return {
      read: (id, scope, context) => this.read(provider, id, scope, context),
      validate: (transaction, context) =>
        this.validate(provider, transaction, context),
      write: (transaction, context) =>
        this.edit(provider, transaction, context),
      removeOverride: (transaction, context) =>
        this.edit(provider, transaction, context),
    };
  }

  /** For ordinary display only. Editors retain raw read values privately for masked retention. */
  maskRead(
    extensionId: string,
    descriptorId: string,
    read: ScopedReadResult,
  ): ScopedReadResult {
    const descriptor = this.providers
      .get(extensionId)
      ?.catalog.descriptors.find((entry) => entry.id === descriptorId);
    if (!descriptor || read.state !== "available")
      return { state: "error", scope: read.scope, message: unavailable };
    return {
      ...read,
      configured: read.configured.present
        ? { present: true, value: maskValue(read.configured.value, descriptor) }
        : { present: false },
      effective: read.effective.known
        ? { known: true, value: maskValue(read.effective.value, descriptor) }
        : { known: false },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    this.off = [];
    for (const [id, provider] of this.providers) this.remove(id, provider);
    for (const controller of this.controllers) controller.abort();
    // Keep bounded in-flight outcome observers until their wrapper promises settle.
    if (this.activeEdits === 0) this.listeners.clear();
  }

  private notify(change: RegistryChange): void {
    if (change.type === "diagnostic") {
      try {
        this.onDiagnostic?.(change.message);
      } catch {
        /* Isolate host diagnostics, including constructor discovery. */
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(change));
      } catch {
        /* Isolate UI observers. */
      }
    }
  }

  private accept(payload: unknown): void {
    if (this.disposed) return;
    try {
      if (!validRegistration(payload)) {
        this.notify({
          type: "diagnostic",
          message: "Invalid or unsupported extension settings registration.",
        });
        return;
      }
      const previous = this.providers.get(payload.extensionId);
      if (previous && previous.owner !== payload.owner) {
        this.notify({
          type: "diagnostic",
          message:
            "Extension settings identity is already owned by another runtime.",
        });
        return;
      }
      // IDs also must not collide across providers: global search/UI use descriptor identities.
      const ids = new Set(payload.descriptors.map((entry) => entry.id));
      if (
        [...this.providers.entries()].some(
          ([id, provider]) =>
            id !== payload.extensionId &&
            provider.catalog.descriptors.some((entry) => ids.has(entry.id)),
        )
      ) {
        this.notify({
          type: "diagnostic",
          message:
            "Extension setting identity conflicts with an existing registration.",
        });
        return;
      }
      const catalog: RegisteredExtension = {
        extensionId: payload.extensionId,
        displayName: payload.displayName,
        tab: "Extensions",
        supportsRemoveOverride:
          typeof payload.operations.removeOverride === "function",
        pages: structuredClone(payload.pages),
        descriptors: payload.descriptors.map((entry) => ({
          ...structuredClone(entry),
          sourceLabel: `Extensions / ${payload.displayName} / ${payload.pages.find((page) => page.id === entry.pageId)?.label}`,
        })),
      };
      const fingerprint = JSON.stringify(catalog);
      if (
        previous?.fingerprint === fingerprint &&
        previous.originalReceiver === payload.operations &&
        sameOperations(previous.originalOperations, payload.operations)
      )
        return;
      let lane = this.lanes.get(payload.extensionId);
      if (!lane) {
        lane = { busy: false, pending: false, epoch: 0, readBack: new Map() };
        this.lanes.set(payload.extensionId, lane);
      }
      const original = payload.operations;
      const operations: SettingsOperations = {
        read: original.read.bind(original),
        validate: original.validate.bind(original),
        write: original.write.bind(original),
        ...(original.removeOverride
          ? { removeOverride: original.removeOverride.bind(original) }
          : {}),
      };
      const provider: Provider = {
        owner: payload.owner,
        catalog,
        fingerprint,
        operations,
        originalOperations: {
          read: original.read,
          validate: original.validate,
          write: original.write,
          ...(original.removeOverride
            ? { removeOverride: original.removeOverride }
            : {}),
        },
        originalReceiver: original,
        rawReads: new Map(),
        lane,
        active: true,
      };
      // Commit before notifying: reentrant observers must never see an unowned slot
      // during replacement, and invalid replacements must leave the old catalog intact.
      if (previous) {
        previous.active = false;
        previous.rawReads.clear();
      }
      this.providers.set(payload.extensionId, provider);
      if (previous)
        this.notify({
          type: "withdrawn",
          extensionId: payload.extensionId,
          descriptorIds: previous.catalog.descriptors.map((entry) => entry.id),
        });
      this.notify({ type: "registered", extensionId: payload.extensionId });
    } catch {
      this.notify({
        type: "diagnostic",
        message:
          "Invalid extension settings registration. Provider diagnostics were withheld.",
      });
    }
  }

  private withdraw(payload: unknown): void {
    try {
      if (
        !record(payload) ||
        payload.protocolVersion !== 1 ||
        typeof payload.extensionId !== "string"
      )
        return;
      const provider = this.providers.get(payload.extensionId);
      if (provider && provider.owner === payload.owner)
        this.remove(payload.extensionId, provider);
    } catch {
      /* Untrusted payload shape cannot disable discovery. */
    }
  }

  private remove(id: string, provider: Provider): void {
    provider.active = false;
    provider.rawReads.clear();
    this.providers.delete(id);
    this.notify({
      type: "withdrawn",
      extensionId: id,
      descriptorIds: provider.catalog.descriptors.map((entry) => entry.id),
    });
  }

  private descriptor(
    provider: Provider,
    id: string,
    scope: Scope,
  ): SettingDescriptor | undefined {
    return !this.disposed && provider.active
      ? provider.catalog.descriptors.find(
          (entry) => entry.id === id && entry.scopes.includes(scope),
        )
      : undefined;
  }

  private async read(
    provider: Provider,
    id: string,
    scope: Scope,
    context?: OperationContext,
  ): Promise<ScopedReadResult> {
    if (!this.descriptor(provider, id, scope))
      return { state: "unavailable", scope, reason: unavailable };
    const epoch = provider.lane.epoch;
    const pending = provider.lane.pending;
    provider.rawReads.delete(key(id, scope));
    const outcome = await this.invoke(
      (signal) => provider.operations.read(id, scope, { signal }),
      context?.signal,
    );
    if (!this.descriptor(provider, id, scope))
      return { state: "unavailable", scope, reason: unavailable };
    if (outcome.state !== "returned")
      return {
        state: "error",
        scope,
        message: outcome.state === "timeout" ? timedOut : failed,
      };
    const read = safeRead(outcome.value, scope);
    if (
      read.state === "available" &&
      !pending &&
      !provider.lane.pending &&
      epoch === provider.lane.epoch
    ) {
      // Never share this raw baseline with the caller's mutable read snapshot.
      provider.rawReads.set(key(id, scope), structuredClone(read));
      provider.lane.readBack.delete(key(id, scope));
    } else provider.rawReads.delete(key(id, scope));
    return read;
  }

  private localValidation(
    provider: Provider,
    transaction: EditTransaction,
  ): ValidationResult {
    if (
      !record(transaction) ||
      !["set", "rename", "remove-override"].includes(transaction.operation) ||
      typeof transaction.expectedRevision !== "string"
    )
      return { valid: false, message: "Invalid edit transaction." };
    const descriptor = this.descriptor(
      provider,
      transaction.descriptorId,
      transaction.scope,
    );
    if (!descriptor) return { valid: false, message: unavailable };
    if (transaction.operation === "remove-override") return { valid: true };
    if (transaction.operation === "rename" && !validId(transaction.destination))
      return { valid: false, message: "Invalid destination identity." };
    if (!json(transaction.value))
      return { valid: false, message: "Value is not JSON-compatible." };
    // This method only receives restored values. Marker shape is not a schema value.
    if (containsMasked(transaction.value))
      return {
        valid: false,
        message: "Masked retention is unavailable; refresh the entry.",
      };
    return validateValue(descriptor.schema, transaction.value);
  }

  private restoreTransaction(
    provider: Provider,
    input: EditTransaction,
  ): EditTransaction | undefined {
    if (
      !record(input) ||
      input.operation === "remove-override" ||
      !json(input.value)
    )
      return input;
    if (!containsMasked(input.value)) return input;
    if (
      typeof input.descriptorId !== "string" ||
      !["user", "project"].includes(input.scope) ||
      typeof input.expectedRevision !== "string"
    )
      return undefined;
    const baseline = provider.rawReads.get(
      key(input.descriptorId, input.scope),
    );
    if (
      !baseline ||
      input.expectedRevision !== baseline.revision ||
      !baseline.configured.present
    )
      return undefined;
    if (containsMasked(baseline.configured.value)) return undefined;
    try {
      // Opaque references resolve only against the private scoped revision snapshot.
      return {
        ...input,
        value: restoreMasked(input.value, baseline.configured.value),
      };
    } catch {
      return undefined;
    }
  }

  private async validate(
    provider: Provider,
    transaction: EditTransaction,
    context?: OperationContext,
  ): Promise<ValidationResult> {
    const restored = this.restoreTransaction(provider, transaction);
    if (!restored)
      return {
        valid: false,
        message: "Masked retention is unavailable; refresh the entry.",
      };
    const local = this.localValidation(provider, restored);
    if (!local.valid) return local;
    const outcome = await this.invoke(
      (signal) =>
        provider.operations.validate(structuredClone(restored), { signal }),
      context?.signal,
    );
    if (!this.descriptor(provider, transaction.descriptorId, transaction.scope))
      return { valid: false, message: unavailable };
    if (outcome.state !== "returned")
      return {
        valid: false,
        message: outcome.state === "timeout" ? timedOut : failed,
      };
    try {
      return record(outcome.value) && outcome.value.valid === true
        ? { valid: true }
        : {
            valid: false,
            message:
              "Extension rejected validation. Provider diagnostics were withheld.",
          };
    } catch {
      return { valid: false, message: failed };
    }
  }

  private async edit(
    provider: Provider,
    transaction: EditTransaction,
    context?: OperationContext,
  ): Promise<EditResult> {
    this.activeEdits++;
    let result: EditResult;
    try {
      result = await this.performEdit(provider, transaction, context);
    } catch {
      result = { state: "failed", message: failed };
    }
    this.notify({
      type: "operation",
      extensionId: provider.catalog.extensionId,
      descriptorId: transaction.descriptorId,
      scope: transaction.scope,
      current: provider.active && !this.disposed,
      state: result.state,
    });
    this.activeEdits--;
    if (this.disposed && this.activeEdits === 0) this.listeners.clear();
    return result;
  }

  private async performEdit(
    provider: Provider,
    input: EditTransaction,
    context?: OperationContext,
  ): Promise<EditResult> {
    const restored = this.restoreTransaction(provider, input);
    const local = restored
      ? this.localValidation(provider, restored)
      : {
          valid: false,
          message: "Masked retention is unavailable; refresh the entry.",
        };
    if (!local.valid)
      return {
        state: "rejected",
        reason: "validation",
        message: local.message,
      };
    const lane = provider.lane;
    if (lane.busy)
      return {
        state: "rejected",
        reason: "unavailable",
        message: "Another edit for this extension is in progress.",
      };
    lane.busy = true;
    try {
      const transaction = structuredClone(restored as EditTransaction);
      // A replacement can retire the only row through which a barrier could be read.
      // Recover only those retired rows, using the original bound callback, never
      // the replacement's unrelated read implementation.
      if (!lane.pending && lane.readBack.size)
        await this.recoverRetired(provider, context);
      if (lane.pending || lane.readBack.size)
        return {
          state: "indeterminate",
          requiresReadBack: true,
          message: uncertain,
        };
      const validated = await this.validate(provider, transaction, context);
      if (!validated.valid)
        return {
          state: "rejected",
          reason: "validation",
          message: validated.message,
        };
      if (
        context?.signal.aborted ||
        !this.descriptor(provider, transaction.descriptorId, transaction.scope)
      )
        return {
          state: "rejected",
          reason: "unavailable",
          message: unavailable,
        };
      const callback =
        transaction.operation === "remove-override"
          ? provider.operations.removeOverride
          : provider.operations.write;
      if (!callback)
        return {
          state: "rejected",
          reason: "unavailable",
          message: "Extension does not support removing overrides.",
        };
      lane.epoch++;
      lane.pending = true;
      const barrier = key(transaction.descriptorId, transaction.scope);
      const recovery: ReadBack = {
        id: transaction.descriptorId,
        scope: transaction.scope,
        read: provider.operations.read,
      };
      provider.rawReads.delete(barrier);
      const outcome = await this.invoke(
        (signal) => callback(structuredClone(transaction), { signal }),
        context?.signal,
        () => {
          lane.pending = false;
        },
        () => {
          lane.readBack.set(barrier, recovery);
        },
      );
      if (outcome.state === "timeout" || outcome.state === "cancelled")
        return {
          state: "indeterminate",
          requiresReadBack: true,
          message: uncertain,
        };
      if (outcome.state !== "returned")
        return { state: "failed", message: failed };
      const result = safeEdit(outcome.value, transaction.scope);
      if (result.state === "indeterminate")
        lane.readBack.set(barrier, recovery);
      return result;
    } finally {
      lane.busy = false;
    }
  }

  private async recoverRetired(
    provider: Provider,
    context?: OperationContext,
  ): Promise<void> {
    const lane = provider.lane;
    for (const [barrier, recovery] of [...lane.readBack]) {
      if (
        lane.pending ||
        context?.signal.aborted ||
        !provider.active ||
        this.disposed
      )
        return;
      if (this.descriptor(provider, recovery.id, recovery.scope)) continue;
      const epoch = lane.epoch;
      const outcome = await this.invoke(
        (signal) => recovery.read(recovery.id, recovery.scope, { signal }),
        context?.signal,
      );
      if (
        outcome.state === "returned" &&
        safeRead(outcome.value, recovery.scope).state === "available" &&
        !lane.pending &&
        epoch === lane.epoch &&
        provider.active &&
        !this.disposed &&
        lane.readBack.get(barrier) === recovery
      )
        lane.readBack.delete(barrier);
    }
  }

  private invoke<T>(
    callback: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    settled?: () => void,
    uncertainOutcome?: () => void,
  ): Promise<Invocation<T>> {
    if (signal?.aborted) {
      settled?.();
      return Promise.resolve({ state: "cancelled" });
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    return new Promise((resolve) => {
      let finished = false;
      let timer: unknown;
      const finish = (outcome: Invocation<T>) => {
        if (finished) return;
        finished = true;
        this.scheduler.clearTimeout(timer);
        signal?.removeEventListener("abort", cancelled);
        controller.signal.removeEventListener("abort", internalCancelled);
        this.controllers.delete(controller);
        resolve(outcome);
      };
      const cancel = (state: "cancelled" | "timeout") => {
        if (finished) return;
        uncertainOutcome?.();
        // Settle the visible outcome first so cooperative rejection cannot turn a timeout into failure.
        finish({ state });
        controller.abort();
      };
      const cancelled = () => cancel("cancelled");
      const internalCancelled = () => cancel("cancelled");
      signal?.addEventListener("abort", cancelled, { once: true });
      controller.signal.addEventListener("abort", internalCancelled, {
        once: true,
      });
      timer = this.scheduler.setTimeout(
        () => cancel("timeout"),
        SETTINGS_OPERATION_DEADLINE_MS,
      );
      // Dispatch synchronously: cancellation/withdrawal cannot create a deferred stale write.
      // Promise handlers consume late rejection/success without resolving the UI again.
      let promise: Promise<T>;
      try {
        promise = Promise.resolve(callback(controller.signal));
      } catch {
        settled?.();
        finish({ state: "threw" });
        return;
      }
      promise.then(
        (value) => {
          settled?.();
          finish({ state: "returned", value });
        },
        () => {
          settled?.();
          finish({ state: "threw" });
        },
      );
    });
  }
}

function containsMasked(value: JsonValue): boolean {
  if (isMasked(value)) return true;
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).some(containsMasked)
  );
}
function key(id: string, scope: Scope): string {
  return `${id}:${scope}`;
}
function sameOperations(a: SettingsOperations, b: SettingsOperations): boolean {
  return (
    a.read === b.read &&
    a.validate === b.validate &&
    a.write === b.write &&
    a.removeOverride === b.removeOverride
  );
}
function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (entry) => "value" in entry,
    )
  );
}
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value)
  );
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4000 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}
function sensitivity(value: unknown): boolean {
  return value === "public" || value === "masked";
}
function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) return false;
  return true;
}
function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function validRegistration(value: unknown): value is SettingsRegistration {
  if (
    !record(value) ||
    value.protocolVersion !== 1 ||
    !validId(value.extensionId) ||
    !text(value.displayName) ||
    !value.displayName.trim() ||
    !(
      (typeof value.owner === "object" && value.owner !== null) ||
      typeof value.owner === "symbol"
    )
  )
    return false;
  if (
    !denseArray(value.pages) ||
    !value.pages.length ||
    !value.pages.every(
      (page) =>
        record(page) &&
        validId(page.id) &&
        text(page.label) &&
        page.label.trim() &&
        text(page.description),
    ) ||
    !unique(value.pages.map((page) => (record(page) ? page.id : undefined)))
  )
    return false;
  if (
    !denseArray(value.descriptors) ||
    !value.descriptors.length ||
    !unique(
      value.descriptors.map((entry) => (record(entry) ? entry.id : undefined)),
    )
  )
    return false;
  const pages = new Set(
    value.pages.map((page) => (record(page) ? page.id : undefined)),
  );
  if (
    !value.descriptors.every(
      (entry) =>
        record(entry) &&
        validId(entry.id) &&
        entry.providerId === value.extensionId &&
        pages.has(entry.pageId) &&
        denseArray(entry.path) &&
        entry.path.length > 0 &&
        entry.path.every(
          (part) =>
            typeof part === "string" &&
            part.length > 0 &&
            part.length <= 200 &&
            text(part) &&
            !["__proto__", "constructor", "prototype"].includes(part),
        ) &&
        text(entry.label) &&
        entry.label.trim() &&
        text(entry.description) &&
        text(entry.sourceLabel) &&
        sensitivity(entry.sensitivity) &&
        (entry.metadataSensitivity === undefined ||
          sensitivity(entry.metadataSensitivity)) &&
        (entry.searchTerms === undefined ||
          (denseArray(entry.searchTerms) &&
            entry.searchTerms.every((term) => text(term)))) &&
        ["immediate", "reload", "restart"].includes(
          entry.activation as string,
        ) &&
        denseArray(entry.scopes) &&
        entry.scopes.length > 0 &&
        unique(entry.scopes) &&
        entry.scopes.every(
          (scope) => scope === "user" || scope === "project",
        ) &&
        schema(entry.schema),
    )
  )
    return false;
  return (
    record(value.operations) &&
    typeof value.operations.read === "function" &&
    typeof value.operations.validate === "function" &&
    typeof value.operations.write === "function" &&
    (value.operations.removeOverride === undefined ||
      typeof value.operations.removeOverride === "function")
  );
}

function schema(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): value is ValueSchema {
  if (!record(value) || depth > 32 || ancestors.has(value)) return false;
  const next = new Set(ancestors).add(value);
  const child = (entry: unknown) => schema(entry, next, depth + 1);
  const bound = (name: string, integral = false) =>
    value[name] === undefined ||
    (typeof value[name] === "number" &&
      Number.isFinite(value[name]) &&
      (!integral || (Number.isInteger(value[name]) && value[name] >= 0)));
  const ordered = (min: string, max: string) =>
    value[min] === undefined ||
    value[max] === undefined ||
    (value[min] as number) <= (value[max] as number);
  switch (value.kind) {
    case "json":
    case "boolean":
      return true;
    case "text":
      return (
        bound("minLength", true) &&
        bound("maxLength", true) &&
        ordered("minLength", "maxLength")
      );
    case "number":
      return (
        bound("minimum") &&
        bound("maximum") &&
        bound("exclusiveMinimum") &&
        ordered("minimum", "maximum") &&
        (value.exclusiveMinimum === undefined ||
          value.maximum === undefined ||
          (value.exclusiveMinimum as number) < (value.maximum as number)) &&
        (value.integer === undefined || typeof value.integer === "boolean")
      );
    case "choice":
      return (
        denseArray(value.values) &&
        value.values.length > 0 &&
        unique(value.values) &&
        value.values.every(
          (entry) =>
            entry === null ||
            typeof entry === "string" ||
            typeof entry === "boolean" ||
            (typeof entry === "number" && Number.isFinite(entry)),
        )
      );
    case "union":
      return (
        denseArray(value.variants) &&
        value.variants.length > 0 &&
        value.variants.every(child)
      );
    case "list":
      return (
        child(value.item) &&
        bound("minItems", true) &&
        bound("maxItems", true) &&
        ordered("minItems", "maxItems")
      );
    case "map":
      return child(value.value);
    case "structured":
      return (
        typeof value.preserveUnknown === "boolean" &&
        record(value.fields) &&
        Object.entries(value.fields).every(
          ([name, field]) =>
            validId(name) &&
            record(field) &&
            typeof field.required === "boolean" &&
            sensitivity(field.sensitivity) &&
            text(field.description) &&
            child(field.schema),
        )
      );
    default:
      return false;
  }
}

/** Cycle/depth guards also protect the generic validator and structuredClone boundary. */
function json(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 64 || ancestors.has(value))
    return false;
  const next = new Set(ancestors).add(value);
  return denseArray(value)
    ? value.every((entry) => json(entry, next, depth + 1))
    : record(value) &&
        Object.values(value).every((entry) => json(entry, next, depth + 1));
}

function safeRead(value: unknown, scope: Scope): ScopedReadResult {
  try {
    if (!record(value) || value.scope !== scope) throw new Error();
    if (value.state === "unavailable")
      return { state: "unavailable", scope, reason: unavailable };
    if (value.state === "error")
      return { state: "error", scope, message: failed };
    if (
      value.state !== "available" ||
      typeof value.revision !== "string" ||
      !record(value.configured) ||
      !record(value.effective) ||
      !record(value.provenance)
    )
      throw new Error();
    if (
      !(
        value.configured.present === false ||
        (value.configured.present === true && json(value.configured.value))
      ) ||
      !(
        value.effective.known === false ||
        (value.effective.known === true && json(value.effective.value))
      ) ||
      !["default", "user", "project", "host-override"].includes(
        value.provenance.source as string,
      ) ||
      !["known", "unknown"].includes(value.provenance.sessionState as string)
    )
      throw new Error();
    return {
      state: "available",
      scope,
      revision: value.revision,
      configured: value.configured.present
        ? {
            present: true,
            value: structuredClone(value.configured.value as JsonValue),
          }
        : { present: false },
      effective: value.effective.known
        ? {
            known: true,
            value: structuredClone(value.effective.value as JsonValue),
          }
        : { known: false },
      provenance: {
        source: value.provenance.source as "default" | Scope | "host-override",
        sessionState: value.provenance.sessionState as "known" | "unknown",
      },
    };
  } catch {
    return { state: "error", scope, message: failed };
  }
}

function safeEdit(value: unknown, scope: Scope): EditResult {
  try {
    if (!record(value)) throw new Error();
    switch (value.state) {
      case "persisted": {
        const read = safeRead(value.read, scope);
        if (read.state !== "available" || !record(value.activation))
          throw new Error();
        const activation = value.activation;
        if (activation.state === "active")
          return { state: "persisted", read, activation: { state: "active" } };
        if (
          activation.state === "required" &&
          (activation.requirement === "reload" ||
            activation.requirement === "restart")
        )
          return {
            state: "persisted",
            read,
            activation: {
              state: "required",
              requirement: activation.requirement,
            },
          };
        if (
          activation.state === "failed" &&
          ["immediate", "reload", "restart"].includes(
            activation.requirement as string,
          )
        )
          return {
            state: "persisted",
            read,
            activation: {
              state: "failed",
              requirement: activation.requirement as
                | "immediate"
                | "reload"
                | "restart",
              message:
                "Saved, but activation failed. Provider diagnostics were withheld.",
            },
          };
        throw new Error();
      }
      case "rejected":
        if (
          ["validation", "conflict", "unavailable"].includes(
            value.reason as string,
          )
        )
          return {
            state: "rejected",
            reason: value.reason as "validation" | "conflict" | "unavailable",
            message:
              "Extension rejected the edit. Provider diagnostics were withheld.",
          };
        throw new Error();
      case "indeterminate":
        return {
          state: "indeterminate",
          requiresReadBack: true,
          message: uncertain,
        };
      default:
        return { state: "failed", message: failed };
    }
  } catch {
    return { state: "failed", message: failed };
  }
}
