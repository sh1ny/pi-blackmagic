import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type {
  EditResult,
  EditTransaction,
  JsonValue,
  Scope,
  ScopedReadResult,
  SettingDescriptor,
} from "./contracts.ts";
import {
  displayText,
  editorDefault,
  editorDisplayValue,
  type EditorView,
  type EditorSuggestions,
  printableInput,
  safeEditorValue,
  TypedEditor,
  validEditorDraft,
} from "./editors.ts";
import { isMasked } from "./redaction.ts";
import { MetadataSearchIndex } from "./search.ts";

export interface CenterRow {
  descriptor: SettingDescriptor;
  read(scope: Scope): Promise<ScopedReadResult>;
  write(transaction: EditTransaction): Promise<EditResult>;
  removeOverride?(transaction: EditTransaction): Promise<EditResult>;
  delete?(scope: Scope, revision: string): Promise<EditResult>;
  /** Advisory conflicts are acknowledged before dispatch; thrown diagnostics are withheld. */
  warnings?(transaction: EditTransaction): Promise<readonly string[]>;
  keyCapture?: boolean;
  initialValue?: JsonValue;
  initialField?: string;
  /** Local editor metadata only; never changes persistence schema or resolves authentication. */
  editorSuggestions?(scope: Scope): Promise<EditorSuggestions>;
}
export const DEFAULT_TABS = [
  "General",
  "Appearance",
  "Models",
  "Context",
  "Tools",
  "Keybindings",
  "MCP",
  "Extensions",
] as const;
export interface CenterOptions {
  onChange: () => void;
  onClose: () => void;
  tabs?: readonly string[];
  bodyHeight?: number;
  /** Bounded backend acknowledgement deadline; production default is ten seconds. */
  operationTimeoutMs?: number;
}
export interface CenterBodyRow {
  id: string;
  descriptorId: string;
  kind: "setting" | "scope" | "reset" | "delete";
  label: string;
  sourceLabel: string;
  scope: Scope;
  supported: boolean;
  value: string | null;
  readState: "loading" | "available" | "unavailable" | "error";
  configured: { present: boolean; value: string | null } | null;
  effective: { known: boolean; value: string | null } | null;
  provenance: AvailableRead["provenance"] | null;
  selected: boolean;
}
export interface CenterStatus {
  kind:
    | "idle"
    | "loading"
    | "editing"
    | "saving"
    | "saved"
    | "unavailable"
    | "validation"
    | "failure"
    | "indeterminate";
  message: string;
  requiresAcknowledgement: boolean;
}
export interface CenterView {
  tabs: readonly string[];
  tab: string;
  tabIndex: number;
  query: string;
  navigationMode: "settings" | "actions";
  /** Complete row model; visibleRows is its body-height-bounded window. */
  body: readonly CenterBodyRow[];
  visibleRows: readonly CenterBodyRow[];
  selected: number | null;
  scroll: number;
  bodyHeight: number;
  empty: boolean;
  help: string;
  status: CenterStatus;
  editor: EditorView | null;
  pending: boolean;
  closeRequested: boolean;
  closed: boolean;
}
type AvailableRead = Extract<ScopedReadResult, { state: "available" }>;
interface QueuedRead {
  row: CenterRow;
  scope: Scope;
  key: string;
  epoch: number;
  promise: Promise<ScopedReadResult>;
  resolve: (result: ScopedReadResult) => void;
}
interface EditSession {
  row: CenterRow;
  scope: Scope;
  baseline: AvailableRead;
  editor: TypedEditor;
}
interface WarningSession {
  row: CenterRow;
  scope: Scope;
  transaction: EditTransaction;
  count: number;
  selected: number;
}
interface DeleteSession {
  row: CenterRow;
  scope: Scope;
  revision: string;
  selected: number;
}
const idle: CenterStatus = {
  kind: "idle",
  message: "Enter edits. Typing searches every tab.",
  requiresAcknowledgement: false,
};
const safeFailure =
  "Settings save failed. The last confirmed persisted value is retained; sensitive diagnostics are withheld.";
const timeoutFailure =
  "Save outcome is indeterminate. No rollback is claimed. Acknowledge, then read back this entry before retrying.";

/** Controller only: no TUI lifecycle, width/layout decisions, filesystem, or backend ownership. */
export class SettingsCenterController {
  private rows: CenterRow[];
  private readonly index: MetadataSearchIndex;
  private readonly options: CenterOptions;
  private readonly tabs: string[];
  private tabIndex = 0;
  private query = "";
  private navigationMode: CenterView["navigationMode"] = "settings";
  private actionDescriptor: string | undefined;
  private readonly selections = new Map<string, string>();
  private searchSelection: string | undefined;
  private readonly scopes = new Map<string, Scope>();
  private readonly confirmed = new Map<string, AvailableRead>();
  private readonly outcomes = new Map<string, ScopedReadResult>();
  private readonly epochs = new Map<string, number>();
  private readonly queuedReads = new Map<string, QueuedRead>();
  private readQueue: QueuedRead[] = [];
  private activeReads = 0;
  private readonly readBackRequired = new Set<string>();
  private bodyHeight: number;
  private scroll = 0;
  private status: CenterStatus = { ...idle };
  private session: EditSession | null = null;
  private deletion: DeleteSession | null = null;
  private warning: WarningSession | null = null;
  private checkingWarnings = false;
  private readGeneration = 0;
  private pending = false;
  private closeRequested = false;
  private closed = false;
  private disposed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(rows: readonly CenterRow[], options: CenterOptions) {
    this.rows = [...rows];
    this.options = options;
    this.tabs = options.tabs?.length ? [...options.tabs] : [...DEFAULT_TABS];
    this.bodyHeight = Math.max(
      1,
      Number.isFinite(options.bodyHeight ?? 12)
        ? Math.floor(options.bodyHeight ?? 12)
        : 1,
    );
    this.index = new MetadataSearchIndex(rows.map((row) => row.descriptor));
    this.normalizeSelection();
    this.prefetch();
    this.loadSelection();
  }

  private notify(): void {
    if (this.disposed || this.closed) return;
    try {
      this.options.onChange();
    } catch {
      /* Host rendering errors are never rendered as backend diagnostics. */
    }
  }
  private setStatus(
    kind: CenterStatus["kind"],
    message: string,
    requiresAcknowledgement = false,
  ): void {
    this.status = { kind, message, requiresAcknowledgement };
  }
  private key(id: string, scope: Scope): string {
    return JSON.stringify([id, scope]);
  }
  private row(id: string): CenterRow | undefined {
    return this.rows.find((row) => row.descriptor.id === id);
  }
  private scope(row: CenterRow): Scope {
    return (
      this.scopes.get(row.descriptor.id) ??
      (row.descriptor.scopes.includes("user") ? "user" : "project")
    );
  }
  private tab(row: CenterRow): string {
    const descriptor = row.descriptor;
    return (
      this.tabs.find(
        (tab) =>
          descriptor.sourceLabel.toLowerCase() === tab.toLowerCase() ||
          descriptor.sourceLabel
            .toLowerCase()
            .startsWith(`${tab.toLowerCase()} /`),
      ) ??
      this.tabs.find(
        (tab) => descriptor.pageId.toLowerCase() === tab.toLowerCase(),
      ) ??
      (this.tabs.includes("Extensions")
        ? "Extensions"
        : (this.tabs[this.tabs.length - 1] as string))
    );
  }
  private entries(): CenterBodyRow[] {
    const selected = this.query
      ? this.searchSelection
      : this.selections.get(this.tabs[this.tabIndex] as string);
    const rows = this.query
      ? this.index.search(this.query).flatMap((match) => {
          const row = this.row(match.descriptor.id);
          return row ? [row] : [];
        })
      : this.rows.filter((row) => this.tab(row) === this.tabs[this.tabIndex]);
    return rows.flatMap((row) => {
      const d = row.descriptor;
      const scope = this.scope(row);
      const cacheKey = this.key(d.id, scope);
      const baseline = this.confirmed.get(cacheKey);
      const outcome = this.outcomes.get(cacheKey);
      const value = baseline?.configured.present
        ? baseline.configured.value
        : baseline?.effective.known
          ? baseline.effective.value
          : undefined;
      const sourceLabel =
        d.metadataSensitivity === "masked"
          ? "Private setting metadata"
          : displayText(d.sourceLabel);
      const configured = baseline
        ? {
            present: baseline.configured.present,
            value: baseline.configured.present
              ? editorDisplayValue(baseline.configured.value)
              : null,
          }
        : null;
      const effective = baseline
        ? {
            known: baseline.effective.known,
            value: baseline.effective.known
              ? editorDisplayValue(baseline.effective.value)
              : null,
          }
        : null;
      const common: Omit<CenterBodyRow, "id" | "kind" | "label" | "selected"> =
        {
          descriptorId: d.id,
          sourceLabel,
          scope,
          supported: d.scopes.includes(scope),
          readState:
            outcome?.state ??
            (d.scopes.includes(scope) ? "loading" : "unavailable"),
          value: null,
          configured,
          effective,
          provenance: baseline ? { ...baseline.provenance } : null,
        };
      const result: Omit<CenterBodyRow, "selected">[] = [
        {
          ...common,
          id: JSON.stringify([d.id, "setting"]),
          kind: "setting",
          label:
            d.metadataSensitivity === "masked"
              ? "Private setting"
              : displayText(d.label),
          value: value === undefined ? null : editorDisplayValue(value),
        },
      ];
      for (const target of ["user", "project"] as const) {
        const targetRead = this.confirmed.get(this.key(d.id, target));
        result.push({
          ...common,
          id: JSON.stringify([d.id, "scope", target]),
          kind: "scope",
          scope: target,
          supported: d.scopes.includes(target),
          readState:
            this.outcomes.get(this.key(d.id, target))?.state ??
            (d.scopes.includes(target) ? "loading" : "unavailable"),
          label: `Scope: ${target}${scope === target ? " (selected)" : ""}${d.scopes.includes(target) ? "" : " (unsupported)"}`,
          configured: targetRead
            ? {
                present: targetRead.configured.present,
                value: targetRead.configured.present
                  ? editorDisplayValue(targetRead.configured.value)
                  : null,
              }
            : null,
          effective: targetRead
            ? {
                known: targetRead.effective.known,
                value: targetRead.effective.known
                  ? editorDisplayValue(targetRead.effective.value)
                  : null,
              }
            : null,
          provenance: targetRead ? { ...targetRead.provenance } : null,
        });
      }
      if (row.removeOverride)
        result.push({
          ...common,
          id: JSON.stringify([d.id, "reset"]),
          kind: "reset",
          label: "Reset to inherited (remove this override)",
        });
      if (row.delete)
        result.push({
          ...common,
          id: JSON.stringify([d.id, "delete"]),
          kind: "delete",
          label: "Delete entry…",
        });
      return result.map((entry) => ({
        ...entry,
        selected: entry.id === selected,
      }));
    });
  }
  private navigableEntries(): CenterBodyRow[] {
    return this.entries().filter((entry) =>
      this.navigationMode === "settings"
        ? entry.kind === "setting"
        : entry.descriptorId === this.actionDescriptor &&
          entry.kind !== "setting",
    );
  }
  private select(id: string | undefined): void {
    if (this.query) this.searchSelection = id;
    else if (id) this.selections.set(this.tabs[this.tabIndex] as string, id);
    else this.selections.delete(this.tabs[this.tabIndex] as string);
  }
  private leaveActions(): void {
    if (this.navigationMode !== "actions") return;
    const descriptor = this.actionDescriptor;
    this.navigationMode = "settings";
    this.actionDescriptor = undefined;
    this.select(
      this.entries().find(
        (entry) =>
          entry.kind === "setting" && entry.descriptorId === descriptor,
      )?.id,
    );
    this.normalizeSelection();
  }
  private normalizeSelection(): void {
    let entries = this.navigableEntries();
    if (!entries.length && this.navigationMode === "actions") {
      this.navigationMode = "settings";
      this.actionDescriptor = undefined;
      entries = this.navigableEntries();
    }
    const remembered = this.query
      ? this.searchSelection
      : this.selections.get(this.tabs[this.tabIndex] as string);
    const id =
      entries.find((entry) => entry.id === remembered)?.id ?? entries[0]?.id;
    if (this.query) this.searchSelection = id;
    else if (id) this.selections.set(this.tabs[this.tabIndex] as string, id);
    else this.selections.delete(this.tabs[this.tabIndex] as string);
    this.ensureVisible();
  }
  private selection(): CenterBodyRow | undefined {
    return this.entries().find((entry) => entry.selected);
  }
  private ensureVisible(): void {
    const entries = this.entries();
    const selected = entries.findIndex((entry) => entry.selected);
    if (selected < 0) {
      this.scroll = 0;
      return;
    }
    this.scroll = Math.min(
      this.scroll,
      Math.max(0, entries.length - this.bodyHeight),
    );
    if (selected < this.scroll) this.scroll = selected;
    if (selected >= this.scroll + this.bodyHeight)
      this.scroll = selected - this.bodyHeight + 1;
  }
  private invalidateRead(): void {
    this.readGeneration++;
  }
  private available(row: CenterRow): boolean {
    return (
      !this.disposed && !this.closed && this.row(row.descriptor.id) === row
    );
  }

  private async bounded<T>(
    operation: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<T>((resolve) => {
          timer = setTimeout(
            () => resolve(fallback),
            Math.max(1, this.options.operationTimeoutMs ?? 10_000),
          );
          this.timers.add(timer);
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(timer);
      }
    }
  }
  private safeRead(row: CenterRow, read: AvailableRead): AvailableRead {
    const mask = (value: JsonValue) =>
      safeEditorValue(row.descriptor.schema, value, row.descriptor.sensitivity);
    return {
      ...read,
      configured: read.configured.present
        ? { present: true, value: mask(read.configured.value) }
        : { present: false },
      effective: read.effective.known
        ? { known: true, value: mask(read.effective.value) }
        : { known: false },
      provenance: { ...read.provenance },
    };
  }
  private async read(row: CenterRow, scope: Scope): Promise<ScopedReadResult> {
    if (!row.descriptor.scopes.includes(scope))
      return { state: "unavailable", scope, reason: "unsupported" };
    const result = await this.bounded<ScopedReadResult>(() => row.read(scope), {
      state: "error",
      scope,
      message: "Read failed.",
    });
    try {
      return result.scope !== scope
        ? { state: "error", scope, message: "Read scope mismatch." }
        : result.state === "available"
          ? this.safeRead(row, result)
          : result.state === "unavailable"
            ? {
                state: "unavailable",
                scope,
                reason: /trust/i.test(result.reason)
                  ? "untrusted"
                  : "unsupported",
              }
            : { state: "error", scope, message: "Read failed." };
    } catch {
      return { state: "error", scope, message: "Read failed." };
    }
  }
  private showReadFailure(
    result: Exclude<ScopedReadResult, { state: "available" }>,
  ): void {
    if (result.state === "unavailable") {
      const trust = result.scope === "project" && /trust/i.test(result.reason);
      this.setStatus(
        "unavailable",
        trust
          ? "Project scope is unavailable because this project is not trusted."
          : `The ${result.scope} scope is unavailable for this setting. No scope was substituted.`,
      );
    } else
      this.setStatus(
        "failure",
        "Settings read failed. Sensitive diagnostic details are withheld.",
      );
  }
  private epoch(key: string): number {
    return this.epochs.get(key) ?? 0;
  }
  private supersede(key: string): number {
    const epoch = this.epoch(key) + 1;
    this.epochs.set(key, epoch);
    const pending = this.queuedReads.get(key);
    if (pending) {
      pending.resolve({
        state: "error",
        scope: pending.scope,
        message: "Read cancelled.",
      });
      this.readQueue = this.readQueue.filter((job) => job !== pending);
    }
    this.queuedReads.delete(key);
    return epoch;
  }
  private cache(key: string, result: ScopedReadResult): void {
    this.outcomes.set(key, result);
    if (result.state === "available") this.confirmed.set(key, result);
    else this.confirmed.delete(key);
  }
  private prefetch(): void {
    for (const row of this.rows) {
      const scope = this.scope(row);
      if (row.descriptor.scopes.includes(scope)) this.cachedRead(row, scope);
    }
  }
  private cachedRead(row: CenterRow, scope: Scope): Promise<ScopedReadResult> {
    const key = this.key(row.descriptor.id, scope);
    const cached = this.outcomes.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.queuedReads.get(key);
    if (pending) return pending.promise;
    let resolve!: QueuedRead["resolve"];
    const promise = new Promise<ScopedReadResult>((done) => {
      resolve = done;
    });
    const job: QueuedRead = {
      row,
      scope,
      key,
      epoch: this.epoch(key),
      promise,
      resolve,
    };
    this.queuedReads.set(key, job);
    this.readQueue.push(job);
    this.pumpReads();
    return promise;
  }
  private pumpReads(): void {
    if (this.disposed || this.closed) return;
    while (this.activeReads < 4 && this.readQueue.length) {
      const job = this.readQueue.shift();
      if (!job) break;
      if (!this.available(job.row) || this.epoch(job.key) !== job.epoch) {
        job.resolve({
          state: "error",
          scope: job.scope,
          message: "Read cancelled.",
        });
        continue;
      }
      this.activeReads++;
      void this.read(job.row, job.scope).then((result) => {
        this.activeReads--;
        if (this.queuedReads.get(job.key) === job)
          this.queuedReads.delete(job.key);
        if (this.available(job.row) && this.epoch(job.key) === job.epoch) {
          this.cache(job.key, result);
          this.notify();
        }
        job.resolve(result);
        this.pumpReads();
      });
    }
  }
  private stopPrefetch(): void {
    for (const job of this.readQueue)
      job.resolve({
        state: "error",
        scope: job.scope,
        message: "Read cancelled.",
      });
    this.readQueue = [];
    this.queuedReads.clear();
  }
  private loadSelection(schedule = true): void {
    this.invalidateRead();
    const entry = this.selection();
    const row = entry && this.row(entry.descriptorId);
    if (
      this.pending ||
      this.session ||
      this.deletion ||
      this.warning ||
      this.checkingWarnings ||
      this.status.requiresAcknowledgement
    )
      return;
    if (!entry || !row) {
      if (["loading", "unavailable", "failure"].includes(this.status.kind))
        this.status = { ...idle };
      return;
    }
    const scope = this.scope(row);
    const key = this.key(row.descriptor.id, scope);
    const cached = this.outcomes.get(key);
    if (cached) {
      if (cached.state !== "available") this.showReadFailure(cached);
      else if (["loading", "unavailable", "failure"].includes(this.status.kind))
        this.status = { ...idle };
      return;
    }
    // Search never schedules backend work. Catalog preloads continue independently.
    if (this.query || !schedule) {
      if (["loading", "unavailable", "failure"].includes(this.status.kind))
        this.status = { ...idle };
      return;
    }
    const generation = this.readGeneration;
    const epoch = this.epoch(key);
    this.setStatus("loading", "Reading selected setting…");
    void this.cachedRead(row, scope).then((result) => {
      if (
        !this.available(row) ||
        generation !== this.readGeneration ||
        epoch !== this.epoch(key)
      )
        return;
      if (result.state === "available") this.status = { ...idle };
      else this.showReadFailure(result);
      this.notify();
    });
  }

  private activate(entry: CenterBodyRow): void {
    const row = this.row(entry.descriptorId);
    if (!row) return;
    const scope = entry.kind === "scope" ? entry.scope : this.scope(row);
    if (entry.kind === "scope") this.scopes.set(row.descriptor.id, scope);
    const key = this.key(row.descriptor.id, scope);
    const epoch = this.supersede(key);
    this.invalidateRead();
    const generation = this.readGeneration;
    this.setStatus("loading", "Reading entry baseline…");
    this.notify();
    void this.read(row, scope).then(async (result) => {
      if (
        !this.available(row) ||
        generation !== this.readGeneration ||
        epoch !== this.epoch(key) ||
        this.selection()?.id !== entry.id
      )
        return;
      this.cache(key, result);
      if (result.state !== "available") {
        this.showReadFailure(result);
        this.notify();
        return;
      }

      const readBack = this.readBackRequired.delete(key);
      if (entry.kind === "scope" || readBack) {
        this.setStatus(
          "idle",
          readBack
            ? "Read-back completed. Review the persisted value, then activate again to edit."
            : `Scope selected: ${scope}.`,
        );
      } else if (entry.kind === "reset") {
        this.save(
          row,
          scope,
          {
            descriptorId: row.descriptor.id,
            scope,
            expectedRevision: result.revision,
            operation: "remove-override",
          },
          "reset",
        );
      } else if (entry.kind === "delete") {
        this.deletion = { row, scope, revision: result.revision, selected: 0 };
        this.setStatus("editing", "Confirm deletion of this entry.");
      } else {
        const schema = row.descriptor.schema;
        // An absent override is a new entry, not a copy of the merged inherited form.
        const complex =
          ["structured", "list", "map", "json"].includes(schema.kind) ||
          (schema.kind === "union" &&
            result.effective.known &&
            result.effective.value !== null &&
            typeof result.effective.value === "object");
        const value = result.configured.present
          ? result.configured.value
          : row.descriptor.sensitivity === "masked"
            ? editorDefault(schema)
            : row.initialValue !== undefined
              ? safeEditorValue(schema, row.initialValue)
              : complex
                ? editorDefault(schema)
                : result.effective.known
                  ? result.effective.value
                  : editorDefault(schema);
        if (
          schema.kind === "boolean" &&
          typeof value === "boolean" &&
          !row.keyCapture &&
          !isMasked(value)
        ) {
          this.save(row, scope, {
            descriptorId: row.descriptor.id,
            scope,
            expectedRevision: result.revision,
            operation: "set",
            value: !value,
          });
        } else {
          const suggestionsFor = row.editorSuggestions;
          const suggestions = suggestionsFor
            ? await this.bounded<EditorSuggestions | undefined>(
                () => suggestionsFor.call(row, scope),
                undefined,
              )
            : undefined;
          if (
            !this.available(row) ||
            generation !== this.readGeneration ||
            epoch !== this.epoch(key) ||
            this.selection()?.id !== entry.id
          )
            return;
          this.session = {
            row,
            scope,
            baseline: result,
            editor: new TypedEditor(schema, value, {
              ...(suggestions ? { suggestions } : {}),
              ...(row.initialField ? { initialField: row.initialField } : {}),
              sensitivity: row.descriptor.sensitivity,
              existingValue: result.configured.present,
              ...(row.keyCapture === undefined
                ? {}
                : { keyCapture: row.keyCapture }),
            }),
          };
          this.setStatus(
            "editing",
            "Edit this entry; completed valid input saves automatically.",
          );
        }
      }
      this.notify();
    });
  }

  private save(
    row: CenterRow,
    scope: Scope,
    transaction: EditTransaction,
    action: "set" | "reset" | "delete" = "set",
    warningsAcknowledged = false,
  ): void {
    if (!this.available(row) || this.pending || this.checkingWarnings) return;
    if (action === "set" && row.warnings && !warningsAcknowledged) {
      this.invalidateRead();
      const generation = this.readGeneration;
      this.checkingWarnings = true;
      this.setStatus(
        "loading",
        "Checking advisory assignment conflicts before saving…",
      );
      this.notify();
      void this.bounded<readonly string[] | null>(
        () => row.warnings?.(transaction) ?? Promise.resolve([]),
        null,
      ).then((warnings) => {
        if (!this.available(row) || generation !== this.readGeneration) return;
        this.checkingWarnings = false;
        if (
          warnings === null ||
          !Array.isArray(warnings) ||
          !warnings.every((message) => typeof message === "string")
        )
          this.setStatus(
            "failure",
            "Assignment warning check failed. No write was dispatched; sensitive diagnostics are withheld.",
            true,
          );
        else if (warnings.length) {
          this.warning = {
            row,
            scope,
            transaction,
            count: warnings.length,
            selected: 0,
          };
          this.setStatus(
            "editing",
            `${warnings.length} potential keybinding conflict(s). Shared keys can be legitimate across host contexts; review before saving.`,
          );
        } else this.save(row, scope, transaction, action, true);
        this.notify();
      });
      return;
    }
    if (transaction.operation === "set") {
      const baseline = this.confirmed.get(this.key(row.descriptor.id, scope));
      const original = baseline?.configured.present
        ? baseline.configured.value
        : null;
      if (
        !validEditorDraft(row.descriptor.schema, transaction.value, original)
      ) {
        this.setStatus(
          "validation",
          "The completed value does not match the setting schema.",
        );
        this.notify();
        return;
      }
    }
    const saveKey = this.key(row.descriptor.id, scope);
    this.supersede(saveKey);
    this.invalidateRead();
    this.pending = true;
    this.setStatus("saving", "Saving; waiting for backend acknowledgement…");
    this.notify();
    const run = (): Promise<EditResult> | undefined => {
      if (!this.available(row))
        return Promise.resolve({
          state: "rejected",
          reason: "unavailable",
          message: "",
        });
      return action === "delete"
        ? row.delete?.(scope, transaction.expectedRevision)
        : action === "reset"
          ? row.removeOverride?.(transaction)
          : row.write(transaction);
    };
    // Only the bounded result changes the UI. A non-cooperating late callback cannot claim success.
    let timedOut = false;
    const fallback: EditResult = {
      state: "indeterminate",
      requiresReadBack: true,
      message: "",
    };
    void this.bounded<EditResult>(async () => {
      try {
        return (await run()) ?? { state: "failed", message: "" };
      } catch {
        return { state: "failed", message: "" };
      }
    }, fallback).then((result) => {
      timedOut = result === fallback;
      this.pending = false;
      try {
        if (result.state === "persisted") {
          if (this.row(row.descriptor.id) === row) {
            this.supersede(saveKey);
            this.cache(saveKey, this.safeRead(row, result.read));
          }
          const activation = result.activation;
          if (activation.state === "active")
            this.setStatus("saved", "Saved and active.");
          else if (activation.state === "required")
            this.setStatus(
              "saved",
              `Saved; ${activation.requirement} required. No automatic activation is performed.`,
            );
          else
            this.setStatus(
              "saved",
              "Saved but not active. Explicit reload or restart may be required; activation diagnostics are withheld.",
            );
        } else if (result.state === "indeterminate" || timedOut) {
          this.readBackRequired.add(this.key(row.descriptor.id, scope));
          this.setStatus("indeterminate", timeoutFailure, true);
        } else {
          const reason =
            result.state === "rejected"
              ? result.reason === "conflict"
                ? " Another writer changed this entry; read a fresh baseline before retrying."
                : result.reason === "validation"
                  ? " Backend validation rejected the entry."
                  : " The selected scope is unavailable."
              : "";
          this.setStatus("failure", safeFailure + reason, true);
        }
      } catch {
        this.setStatus("failure", safeFailure, true);
      }
      if (this.closeRequested && !this.status.requiresAcknowledgement)
        this.finishClose();
      else this.notify();
    });
  }

  handleInput(rawInput: string): void {
    if (this.disposed || this.closed || isKeyRelease(rawInput)) return;
    if (this.status.requiresAcknowledgement) {
      if (matchesKey(rawInput, "enter") || matchesKey(rawInput, "escape")) {
        this.status = { ...idle };
        if (this.closeRequested) this.finishClose();
        else this.notify();
      }
      return;
    }
    if (this.warning) {
      const warning = this.warning;
      if (matchesKey(rawInput, "escape")) {
        this.warning = null;
        this.status = { ...idle };
      } else if (matchesKey(rawInput, "up") || matchesKey(rawInput, "left"))
        warning.selected = 0;
      else if (matchesKey(rawInput, "down") || matchesKey(rawInput, "right"))
        warning.selected = 1;
      else if (matchesKey(rawInput, "enter")) {
        this.warning = null;
        if (warning.selected === 1)
          this.save(
            warning.row,
            warning.scope,
            warning.transaction,
            "set",
            true,
          );
        else this.setStatus("idle", "Assignment edit cancelled before saving.");
      }
      this.notify();
      return;
    }
    if (this.checkingWarnings) {
      if (matchesKey(rawInput, "escape")) {
        this.invalidateRead();
        this.checkingWarnings = false;
        this.setStatus("idle", "Assignment edit cancelled before saving.");
        this.notify();
      }
      return;
    }
    if (this.session) {
      const session = this.session;
      const outcome = session.editor.handleInput(rawInput);
      if (outcome.state === "cancelled") {
        this.session = null;
        this.setStatus(
          "idle",
          "Incomplete entry cancelled. Previously saved settings are unchanged.",
        );
      } else if (outcome.state === "editing") {
        const message = session.editor.view().message;
        this.setStatus(
          message.includes("schema") || message.startsWith("Enter a valid")
            ? "validation"
            : "editing",
          message ||
            "Edit this entry; completed valid input saves automatically.",
        );
      } else if (outcome.state === "complete") {
        this.session = null;
        this.save(session.row, session.scope, {
          descriptorId: session.row.descriptor.id,
          scope: session.scope,
          expectedRevision: session.baseline.revision,
          operation: "set",
          value: outcome.value,
        });
      }
      this.notify();
      return;
    }
    if (this.deletion) {
      const deletion = this.deletion;
      if (matchesKey(rawInput, "escape")) {
        this.deletion = null;
        this.status = { ...idle };
      } else if (matchesKey(rawInput, "up") || matchesKey(rawInput, "left"))
        deletion.selected = 0;
      else if (matchesKey(rawInput, "down") || matchesKey(rawInput, "right"))
        deletion.selected = 1;
      else if (matchesKey(rawInput, "enter")) {
        this.deletion = null;
        if (deletion.selected === 1)
          this.save(
            deletion.row,
            deletion.scope,
            {
              descriptorId: deletion.row.descriptor.id,
              scope: deletion.scope,
              expectedRevision: deletion.revision,
              operation: "remove-override",
            },
            "delete",
          );
        else this.status = { ...idle };
      }
      this.notify();
      return;
    }
    if (matchesKey(rawInput, "escape")) {
      this.invalidateRead();
      if (this.navigationMode === "actions") {
        this.leaveActions();
        this.loadSelection();
        this.notify();
      } else if (this.query) {
        this.query = "";
        this.searchSelection = undefined;
        this.normalizeSelection();
        this.loadSelection();
        this.notify();
      } else if (this.pending) {
        this.closeRequested = true;
        this.setStatus(
          "saving",
          "Closing after the pending save is acknowledged…",
        );
        this.notify();
      } else this.finishClose();
      return;
    }
    if (this.closeRequested) return;
    if (matchesKey(rawInput, "tab")) {
      if (this.navigationMode === "actions") this.leaveActions();
      else {
        this.actionDescriptor = this.selection()?.descriptorId;
        if (this.actionDescriptor) {
          this.navigationMode = "actions";
          this.normalizeSelection();
        }
      }
      this.loadSelection();
    } else if (matchesKey(rawInput, "left") || matchesKey(rawInput, "right")) {
      this.leaveActions();
      this.tabIndex =
        (this.tabIndex +
          (matchesKey(rawInput, "left") ? this.tabs.length - 1 : 1)) %
        this.tabs.length;
      this.normalizeSelection();
      this.loadSelection();
    } else if (matchesKey(rawInput, "up") || matchesKey(rawInput, "down")) {
      const entries = this.navigableEntries();
      const current = Math.max(
        0,
        entries.findIndex((entry) => entry.selected),
      );
      const target =
        entries[
          Math.max(
            0,
            Math.min(
              entries.length - 1,
              current + (matchesKey(rawInput, "up") ? -1 : 1),
            ),
          )
        ];
      if (this.query) this.searchSelection = target?.id;
      else if (target)
        this.selections.set(this.tabs[this.tabIndex] as string, target.id);
      this.ensureVisible();
      this.loadSelection();
    } else if (matchesKey(rawInput, "enter")) {
      const entry = this.selection();
      if (entry && !this.pending) this.activate(entry);
    } else {
      let changed = false;
      if (matchesKey(rawInput, "backspace")) {
        this.leaveActions();
        const chars = Array.from(this.query);
        chars.pop();
        this.query = chars.join("");
        changed = true;
      } else {
        const text = printableInput(rawInput);
        if (text !== undefined) {
          this.leaveActions();
          this.query += text;
          changed = true;
        }
      }
      if (changed) {
        this.searchSelection = undefined;
        this.scroll = 0;
        this.normalizeSelection();
        this.loadSelection(false);
      }
    }
    this.notify();
  }

  resize(bodyHeight: number): void {
    if (this.disposed || this.closed) return;
    this.bodyHeight = Math.max(
      1,
      Number.isFinite(bodyHeight) ? Math.floor(bodyHeight) : 1,
    );
    this.ensureVisible();
    this.notify();
  }
  setRows(newRows: readonly CenterRow[]): void {
    if (this.disposed || this.closed) return;
    this.invalidateRead();
    const previous = this.rows;
    this.rows = [...newRows];
    this.checkingWarnings = false;
    this.index.replace(newRows.map((row) => row.descriptor));
    for (const row of previous)
      if (this.row(row.descriptor.id) !== row)
        for (const scope of ["user", "project"] as const) {
          const key = this.key(row.descriptor.id, scope);
          this.supersede(key);
          this.confirmed.delete(key);
          this.outcomes.delete(key);
        }
    if (
      (this.session && !this.available(this.session.row)) ||
      (this.deletion && !this.available(this.deletion.row)) ||
      (this.warning && !this.available(this.warning.row))
    ) {
      this.session = null;
      this.deletion = null;
      this.warning = null;
      this.setStatus(
        "idle",
        "Entry withdrawn or replaced; its incomplete draft was cancelled.",
      );
    }
    this.normalizeSelection();
    this.prefetch();
    this.loadSelection();
    this.notify();
  }
  private finishClose(): void {
    if (this.closed || this.disposed) return;
    this.closed = true;
    this.stopPrefetch();
    this.invalidateRead();
    this.session = null;
    this.deletion = null;
    this.warning = null;
    this.checkingWarnings = false;
    try {
      this.options.onClose();
    } catch {
      /* Host owns restoration and diagnostics. */
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPrefetch();
    this.invalidateRead();
    this.session = null;
    this.deletion = null;
    this.warning = null;
    this.checkingWarnings = false;
    // Do not cancel acknowledgement deadlines: dispatched saves remain tracked to a bounded outcome.
  }
  view(): CenterView {
    const body = this.entries();
    const selectedIndex = body.findIndex((entry) => entry.selected);
    const entry = selectedIndex < 0 ? undefined : body[selectedIndex];
    const descriptor = entry && this.row(entry.descriptorId)?.descriptor;
    const help = descriptor
      ? `${descriptor.metadataSensitivity === "masked" ? "Private setting metadata" : displayText(descriptor.description)} Scope: ${entry?.scope}. Supported: ${descriptor.scopes.join(", ") || "none"}. Configured: ${entry?.configured ? (entry.configured.present ? entry.configured.value : "absent (inherits)") : "not read"}. Effective: ${entry?.effective ? (entry.effective.known ? entry.effective.value : "unknown") : "not read"}. Source: ${entry?.provenance?.source ?? "unknown"}. Host session: ${entry?.provenance?.sessionState ?? "unknown"}; persisted settings are not necessarily active runtime state.`
      : this.query
        ? "No matching settings. Search is global and contains metadata only."
        : "No settings on this tab.";
    const editor: EditorView | null =
      this.session?.editor.view() ??
      (this.warning
        ? {
            kind: "choice",
            path: [],
            selected: this.warning.selected,
            input: null,
            cursor: 0,
            message: `${this.warning.count} potential assignment conflict(s). This is advisory, not a validation rejection.`,
            help: "Potential overlapping assignment. Shared keys across host contexts may be legitimate. Enter on Save despite warnings acknowledges; Escape cancels.",
            lines: ["Cancel assignment edit", "Save despite warnings"].map(
              (label, index) => ({
                label,
                description: "",
                action: index === 0 ? "cancel" : "acknowledge-warning",
                selected: index === this.warning?.selected,
              }),
            ),
          }
        : null) ??
      (this.deletion
        ? {
            kind: "choice",
            path: [],
            selected: this.deletion.selected,
            input: null,
            cursor: 0,
            message: "Deletion is permanent; no undo is provided.",
            help: "Choose Confirm deletion and press Enter, or Escape to cancel.",
            lines: ["Cancel", "Confirm deletion"].map((label, index) => ({
              label,
              description: "",
              action: index === 0 ? "cancel" : "delete",
              selected: index === this.deletion?.selected,
            })),
          }
        : null);
    return {
      tabs: [...this.tabs],
      tab: this.tabs[this.tabIndex] as string,
      tabIndex: this.tabIndex,
      query: displayText(this.query),
      navigationMode: this.navigationMode,
      body,
      visibleRows: body.slice(this.scroll, this.scroll + this.bodyHeight),
      selected: selectedIndex < 0 ? null : selectedIndex,
      scroll: this.scroll,
      bodyHeight: this.bodyHeight,
      empty: body.length === 0,
      help,
      status: { ...this.status },
      editor,
      pending: this.pending,
      closeRequested: this.closeRequested,
      closed: this.closed,
    };
  }
}
