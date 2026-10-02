import { expect, test } from "bun:test";
import type {
  EditResult,
  OperationContext,
  ScopedReadResult,
  SettingsOperations,
} from "../src/registration.ts";
import { SETTINGS_CHANNELS } from "../src/registration.ts";
import {
  SETTINGS_OPERATION_DEADLINE_MS,
  SettingsRegistry,
  type RegistryChange,
  type RegistryScheduler,
} from "../src/registry.ts";
import {
  persisted,
  SyntheticBus,
  syntheticExtension,
  transaction,
} from "./fixtures/synthetic-extension.ts";

class Clock implements RegistryScheduler {
  now = 0;
  private id = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = ++this.id;
    this.timers.set(id, { at: this.now + milliseconds, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(milliseconds = SETTINGS_OPERATION_DEADLINE_MS): void {
    this.now += milliseconds;
    for (const [id, timer] of [...this.timers])
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.callback();
      }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
const context = (): OperationContext => ({
  signal: new AbortController().signal,
});
function setup() {
  const bus = new SyntheticBus();
  const clock = new Clock();
  const registry = new SettingsRegistry(bus, { scheduler: clock });
  const provider = syntheticExtension();
  return {
    bus,
    clock,
    registry,
    provider,
    announce: () => bus.emit(SETTINGS_CHANNELS.register, provider.payload),
  };
}

test("read hangs are bounded at exactly ten seconds with cooperative cancellation and late values ignored", async () => {
  const { clock, registry, provider, announce } = setup();
  const read = deferred<ScopedReadResult>();
  let signal: AbortSignal | undefined;
  provider.payload.operations.read = (_id, _scope, ctx) => {
    signal = ctx.signal;
    return read.promise;
  };
  announce();
  const pending = registry
    .operations("synthetic")
    ?.read("synthetic.advanced.enabled", "user", context());
  await flush();
  clock.advance(9_999);
  await flush();
  expect(signal?.aborted).toBe(false);
  expect(clock.timers.size).toBe(1);
  clock.advance(1);
  const result = await pending;
  expect(result?.state).toBe("error");
  expect(JSON.stringify(result)).toContain("10-second");
  expect(signal?.aborted).toBe(true);
  expect(clock.timers.size).toBe(0);
  read.resolve(provider.read("user"));
  await flush();
  expect(result?.state).toBe("error");
  registry.dispose();
});

test("validation deadline never dispatches persistence, retry works after validation failure", async () => {
  const { clock, registry, provider, announce } = setup();
  let signal: AbortSignal | undefined;
  provider.payload.operations.validate = async (_transaction, ctx) => {
    signal = ctx.signal;
    return await new Promise(() => {});
  };
  announce();
  const ops = registry.operations("synthetic") as SettingsOperations;
  const pending = ops.write(transaction(), context());
  await flush();
  clock.advance();
  expect((await pending).state).toBe("rejected");
  expect(signal?.aborted).toBe(true);
  expect(provider.calls.write).toBe(0);
  provider.payload.operations.validate = async () => ({ valid: true });
  announce();
  expect(
    (await registry.operations("synthetic")?.write(transaction(), context()))
      ?.state,
  ).toBe("persisted");
  registry.dispose();
});

test("timed-out write requires settlement plus subsequent read-back before retry; late success is not a new UI outcome", async () => {
  const { clock, registry, provider, announce } = setup();
  const write = deferred<EditResult>();
  let signal: AbortSignal | undefined;
  let dispatched = 0;
  provider.payload.operations.write = (_transaction, ctx) => {
    dispatched++;
    signal = ctx.signal;
    return write.promise;
  };
  announce();
  const changes: RegistryChange[] = [];
  registry.subscribe((change) => changes.push(change));
  const ops = registry.operations("synthetic") as SettingsOperations;
  const pending = ops.write(transaction(), context());
  await flush();
  clock.advance();
  expect((await pending).state).toBe("indeterminate");
  expect(signal?.aborted).toBe(true);
  expect((await ops.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  // A read while the old write is still running cannot authorize a retry.
  expect(
    (await ops.read("synthetic.advanced.enabled", "user", context())).state,
  ).toBe("available");
  expect((await ops.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  expect(dispatched).toBe(1);
  const eventsBeforeLate = changes.filter(
    (change) => change.type === "operation",
  ).length;
  write.resolve(persisted());
  await flush();
  expect(changes.filter((change) => change.type === "operation")).toHaveLength(
    eventsBeforeLate,
  );
  expect((await ops.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  // Read-back failure cannot clear the barrier, nor can an unsupported scope.
  provider.payload.operations.read = async () => ({
    state: "error",
    scope: "user",
    message: "synthetic-secret",
  });
  announce();
  const refreshed = registry.operations("synthetic") as SettingsOperations;
  expect(
    (await refreshed.read("synthetic.advanced.enabled", "user", context()))
      .state,
  ).toBe("error");
  expect((await refreshed.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  provider.payload.operations.read = async (_id, scope) => provider.read(scope);
  announce();
  const recovered = registry.operations("synthetic") as SettingsOperations;
  expect(
    (await recovered.read("synthetic.advanced.enabled", "project", context()))
      .state,
  ).toBe("unavailable");
  expect((await recovered.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  expect(
    (await recovered.read("synthetic.advanced.enabled", "user", context()))
      .state,
  ).toBe("available");
  expect((await recovered.write(transaction(), context())).state).toBe(
    "persisted",
  );
  expect(dispatched).toBe(2);
  registry.dispose();
});

test("read started before settlement cannot authorize retry even if it completes after the late write", async () => {
  const { clock, registry, provider, announce } = setup();
  const write = deferred<EditResult>();
  const read = deferred<ScopedReadResult>();
  provider.payload.operations.write = () => write.promise;
  provider.payload.operations.read = () => read.promise;
  announce();
  const ops = registry.operations("synthetic") as SettingsOperations;
  const save = ops.write(transaction(), context());
  await flush();
  clock.advance();
  await save;
  const readBack = ops.read("synthetic.advanced.enabled", "user", context());
  write.resolve(persisted());
  await flush();
  read.resolve(provider.read("user"));
  await readBack;
  expect((await ops.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  registry.dispose();
});

test("hanging remove-override uses the write deadline and blocks retries until settlement/read-back", async () => {
  const { clock, registry, provider, announce } = setup();
  const removal = deferred<EditResult>();
  let signal: AbortSignal | undefined;
  provider.payload.operations.removeOverride = (_transaction, context) => {
    signal = context.signal;
    return removal.promise;
  };
  announce();
  const ops = registry.operations("synthetic") as SettingsOperations;
  const save = ops.removeOverride?.(
    { ...transaction(), operation: "remove-override" },
    context(),
  );
  await flush();
  clock.advance();
  expect((await save)?.state).toBe("indeterminate");
  expect(signal?.aborted).toBe(true);
  expect((await ops.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  removal.resolve(persisted());
  await flush();
  await ops.read("synthetic.advanced.enabled", "user", context());
  expect((await ops.write(transaction(), context())).state).toBe("persisted");
  expect(provider.calls.write).toBe(1);
  registry.dispose();
});

test("synchronous throw and late rejection are consumed without raw diagnostics or timer leaks", async () => {
  const { clock, registry, provider, announce } = setup();
  provider.payload.operations.write = () => {
    throw new Error("synthetic-secret");
  };
  announce();
  const result = await registry
    .operations("synthetic")
    ?.write(transaction(), context());
  expect(result?.state).toBe("failed");
  expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  expect(clock.timers.size).toBe(0);
  const write = deferred<EditResult>();
  provider.payload.operations.write = () => write.promise;
  announce();
  const save = registry
    .operations("synthetic")
    ?.write(transaction(), context());
  await flush();
  clock.advance();
  expect((await save)?.state).toBe("indeterminate");
  write.reject(new Error("synthetic-secret-late"));
  await flush();
  expect(clock.timers.size).toBe(0);
  registry.dispose();
});

test("provider-reported indeterminate outcomes also require read-back", async () => {
  const { registry, provider, announce } = setup();
  provider.payload.operations.write = async () => ({
    state: "indeterminate",
    requiresReadBack: true,
    message: "unsafe",
  });
  announce();
  const ops = registry.operations("synthetic") as SettingsOperations;
  expect((await ops.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  expect((await ops.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  expect(provider.calls.validate).toBe(1);
  await ops.read("synthetic.advanced.enabled", "user", context());
  await ops.write(transaction(), context());
  expect(provider.calls.validate).toBe(2);
  registry.dispose();
});

test("external cancellation propagates AbortSignal and makes a dispatched write indeterminate", async () => {
  const { registry, provider, announce } = setup();
  const write = deferred<EditResult>();
  let callbackSignal: AbortSignal | undefined;
  provider.payload.operations.write = (_transaction, ctx) => {
    callbackSignal = ctx.signal;
    return write.promise;
  };
  announce();
  const ops = registry.operations("synthetic") as SettingsOperations;
  const abort = new AbortController();
  const save = ops.write(transaction(), { signal: abort.signal });
  await flush();
  abort.abort();
  expect((await save).state).toBe("indeterminate");
  expect(callbackSignal?.aborted).toBe(true);
  write.reject(new Error("synthetic-secret-late"));
  await flush();
  expect((await ops.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  await ops.read("synthetic.advanced.enabled", "user", context());
  // Already cancelled operations do not call providers at all.
  const preCancelled = new AbortController();
  preCancelled.abort();
  const calls = provider.calls.validate;
  expect(
    (await ops.write(transaction(), { signal: preCancelled.signal })).state,
  ).toBe("rejected");
  expect(provider.calls.validate).toBe(calls);
  registry.dispose();
});

test("cooperative abort rejection cannot replace indeterminate timeout with failed", async () => {
  const { clock, registry, provider, announce } = setup();
  provider.payload.operations.write = (_transaction, ctx) =>
    new Promise((_resolve, reject) => {
      ctx.signal.addEventListener(
        "abort",
        () => reject(new Error("synthetic-secret")),
        { once: true },
      );
    });
  announce();
  const save = registry
    .operations("synthetic")
    ?.write(transaction(), context());
  await flush();
  clock.advance();
  expect((await save)?.state).toBe("indeterminate");
  await flush();
  registry.dispose();
});

test("one provider's hanging callback does not block another or invoke native storage", async () => {
  const { bus, clock, registry, provider, announce } = setup();
  provider.payload.operations.write = async () => await new Promise(() => {});
  announce();
  const good = syntheticExtension(bus, "good");
  const save = registry
    .operations("synthetic")
    ?.write(transaction(), context());
  await flush();
  expect(
    (await registry.operations("good")?.write(transaction("good"), context()))
      ?.state,
  ).toBe("persisted");
  expect(registry.catalog()).toHaveLength(2);
  clock.advance();
  expect((await save)?.state).toBe("indeterminate");
  good.cleanup();
  registry.dispose();
});

test("provider edits serialize; concurrent edits are rejected rather than racing validation", async () => {
  const { registry, provider, announce } = setup();
  const first = deferred<EditResult>();
  provider.payload.operations.write = () => first.promise;
  announce();
  const ops = registry.operations("synthetic") as SettingsOperations;
  const save = ops.write(transaction(), context());
  await flush();
  expect((await ops.write(transaction(), context())).state).toBe("rejected");
  first.resolve(persisted());
  expect((await save).state).toBe("persisted");
  expect(provider.calls.validate).toBe(1);
  registry.dispose();
});

test("withdrawal cancels incomplete editors via notification; validation in progress cannot dispatch a stale save", async () => {
  const { bus, registry, provider, announce } = setup();
  const validation = deferred<{ valid: true }>();
  provider.payload.operations.validate = () => validation.promise;
  announce();
  const changes: RegistryChange[] = [];
  registry.subscribe((change) => changes.push(change));
  const ops = registry.operations("synthetic") as SettingsOperations;
  const save = ops.write(transaction(), context());
  await flush();
  bus.emit(SETTINGS_CHANNELS.unregister, {
    protocolVersion: 1,
    extensionId: "synthetic",
    owner: provider.payload.owner,
  });
  validation.resolve({ valid: true });
  expect((await save).state).toBe("rejected");
  expect(provider.calls.write).toBe(0);
  expect((await ops.write(transaction(), context())).state).toBe("rejected");
  expect(
    changes.some(
      (change) =>
        change.type === "withdrawn" &&
        change.descriptorIds.includes("synthetic.advanced.enabled"),
    ),
  ).toBe(true);
  registry.dispose();
});

for (const lateSuccess of [true, false]) {
  test(`withdrawal preserves bounded observable in-flight ${lateSuccess ? "acknowledgement" : "timeout"} while stale writes are rejected`, async () => {
    const { bus, clock, registry, provider, announce } = setup();
    const write = deferred<EditResult>();
    provider.payload.operations.write = () => write.promise;
    announce();
    const changes: RegistryChange[] = [];
    registry.subscribe((change) => changes.push(change));
    const ops = registry.operations("synthetic") as SettingsOperations;
    const save = ops.write(transaction(), context());
    await flush();
    bus.emit(SETTINGS_CHANNELS.unregister, {
      protocolVersion: 1,
      extensionId: "synthetic",
      owner: provider.payload.owner,
    });
    expect(registry.catalog()).toEqual([]);
    expect((await ops.write(transaction(), context())).state).toBe("rejected");
    if (lateSuccess) write.resolve(persisted());
    else clock.advance();
    expect((await save).state).toBe(
      lateSuccess ? "persisted" : "indeterminate",
    );
    expect(
      changes.some(
        (change) =>
          change.type === "operation" &&
          !change.current &&
          change.state === (lateSuccess ? "persisted" : "indeterminate"),
      ),
    ).toBe(true);
    registry.dispose();
  });
}

test("shutdown clears bus listeners, cooperatively cancels operations and reports bounded in-flight outcomes", async () => {
  const { bus, clock, registry, provider, announce } = setup();
  let signal: AbortSignal | undefined;
  provider.payload.operations.write = async (_transaction, ctx) => {
    signal = ctx.signal;
    return await new Promise(() => {});
  };
  announce();
  const changes: RegistryChange[] = [];
  registry.subscribe((change) => changes.push(change));
  const ops = registry.operations("synthetic") as SettingsOperations;
  const save = ops.write(transaction(), context());
  await flush();
  registry.dispose();
  registry.dispose();
  expect((await save).state).toBe("indeterminate");
  expect(signal?.aborted).toBe(true);
  expect(bus.count()).toBe(0);
  expect(clock.timers.size).toBe(0);
  expect(
    changes.some(
      (change) =>
        change.type === "operation" &&
        !change.current &&
        change.state === "indeterminate",
    ),
  ).toBe(true);
  expect((await ops.write(transaction(), context())).state).toBe("rejected");
});

for (const retirement of ["descriptor", "scope"] as const) {
  for (const recoveryState of [
    "available",
    "error",
    "hang",
    "cancel",
  ] as const) {
    test(`same-owner ${retirement} retirement recovers settled uncertain writes through original read callback (${recoveryState})`, async () => {
      const { bus, clock, registry, provider, announce } = setup();
      const write = deferred<EditResult>();
      const lateRead = deferred<ScopedReadResult>();
      const originalId = transaction().descriptorId;
      const reads: { id: string; scope: string; signal: AbortSignal }[] = [];
      let recovery: typeof recoveryState | "available" = recoveryState;
      const receiver = {
        ...provider.payload.operations,
        marker: "original-receiver",
        read(
          this: { marker: string },
          id: string,
          scope: "user" | "project",
          ctx: OperationContext,
        ) {
          expect(this.marker).toBe("original-receiver");
          reads.push({ id, scope, signal: ctx.signal });
          if (recovery === "hang" || recovery === "cancel")
            return lateRead.promise;
          return Promise.resolve(
            recovery === "available"
              ? provider.read(scope)
              : { state: "error" as const, scope, message: "synthetic-secret" },
          );
        },
        write: () => write.promise,
      };
      provider.payload.operations = receiver;
      const descriptor = provider.payload.descriptors[0];
      if (!descriptor) throw new Error("Missing fixture descriptor");
      if (retirement === "scope") descriptor.scopes = ["user", "project"];
      announce();
      const original = registry.operations("synthetic") as SettingsOperations;
      const save = original.write(transaction(), context());
      await flush();
      clock.advance();
      expect((await save).state).toBe("indeterminate");
      const activeId =
        retirement === "descriptor"
          ? "synthetic.advanced.remaining"
          : originalId;
      const activeScope =
        retirement === "scope" ? ("project" as const) : ("user" as const);
      let newReads = 0;
      let newWrites = 0;
      bus.emit(SETTINGS_CHANNELS.register, {
        ...provider.payload,
        descriptors: [{ ...descriptor, id: activeId, scopes: [activeScope] }],
        operations: {
          async read(_id: string, scope: "user" | "project") {
            newReads++;
            return provider.read(scope);
          },
          async validate() {
            return { valid: true };
          },
          async write() {
            newWrites++;
            return persisted(activeScope);
          },
        },
      });
      const active = registry.operations("synthetic") as SettingsOperations;
      const input = {
        ...transaction(),
        descriptorId: activeId,
        scope: activeScope,
      };
      expect((await active.write(input, context())).state).toBe(
        "indeterminate",
      );
      expect(reads).toEqual([]);
      // A read of the remaining descriptor cannot clear the retired barrier.
      await active.read(activeId, activeScope, context());
      expect((await active.write(input, context())).state).toBe(
        "indeterminate",
      );
      write.resolve(persisted());
      await flush();
      expect(reads).toEqual([]); // neither replacement nor settlement clears it
      const abort = new AbortController();
      const attempt = active.write(input, { signal: abort.signal });
      await flush();
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ id: originalId, scope: "user" });
      if (recoveryState === "hang") clock.advance();
      if (recoveryState === "cancel") abort.abort();
      const result = await attempt;
      if (recoveryState === "available") {
        expect(result.state).toBe("persisted");
        expect(newWrites).toBe(1);
      } else {
        expect(result.state).toBe("indeterminate");
        expect(newWrites).toBe(0);
        expect(JSON.stringify(result)).not.toContain("synthetic-secret");
        if (recoveryState !== "error") {
          expect(reads[0]?.signal.aborted).toBe(true);
          lateRead.resolve(provider.read("user"));
          await flush();
          expect(newWrites).toBe(0); // late recovery is ignored
        }
        recovery = "available";
        expect((await active.write(input, context())).state).toBe("persisted");
        expect(reads).toHaveLength(2);
        expect(newWrites).toBe(1);
      }
      expect(newReads).toBe(1); // automatic recovery never uses the replacement reader
      expect(clock.timers.size).toBe(0);
      registry.dispose();
    });
  }
}

test("a surviving descriptor still needs explicit user read-back after same-owner replacement", async () => {
  const { bus, clock, registry, provider, announce } = setup();
  const write = deferred<EditResult>();
  let oldReads = 0;
  provider.payload.operations.read = async (_id, scope) => {
    oldReads++;
    return provider.read(scope);
  };
  provider.payload.operations.write = () => write.promise;
  announce();
  const original = registry.operations("synthetic") as SettingsOperations;
  const save = original.write(transaction(), context());
  await flush();
  clock.advance();
  await save;
  let newReads = 0;
  bus.emit(SETTINGS_CHANNELS.register, {
    ...provider.payload,
    operations: {
      ...provider.payload.operations,
      read: async (_id: string, scope: "user" | "project") => {
        newReads++;
        return provider.read(scope);
      },
      write: async () => persisted(),
    },
  });
  write.resolve(persisted());
  await flush();
  const active = registry.operations("synthetic") as SettingsOperations;
  expect((await active.write(transaction(), context())).state).toBe(
    "indeterminate",
  );
  expect(oldReads).toBe(0);
  expect(newReads).toBe(0);
  await active.read(transaction().descriptorId, "user", context());
  expect((await active.write(transaction(), context())).state).toBe(
    "persisted",
  );
  expect(newReads).toBe(1);
  registry.dispose();
});
