import { expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import piSettings from "../src/index.ts";

function host() {
  const channels = new Map<string, Set<(data: unknown) => void>>();
  const lifecycle = new Map<string, () => void>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const calls: string[] = [];
  const events = {
    on(channel: string, callback: (data: unknown) => void) {
      const handlers = channels.get(channel) ?? new Set();
      handlers.add(callback);
      channels.set(channel, handlers);
      return () => {
        handlers.delete(callback);
      };
    },
    emit(channel: string, data: unknown) {
      calls.push(channel);
      for (const callback of channels.get(channel) ?? []) callback(data);
    },
  };
  const pi = {
    events,
    on(event: string, handler: () => void) {
      lifecycle.set(event, handler);
      return () => {
        lifecycle.delete(event);
      };
    },
    registerCommand(
      name: string,
      command: typeof commands extends Map<string, infer T> ? T : never,
    ) {
      expect(commands.has(name)).toBe(false);
      commands.set(name, command);
    },
    getSettings() {
      throw new Error("Factory/guard must not inspect configuration");
    },
  } as unknown as ExtensionAPI;
  return { pi, channels, lifecycle, commands, calls };
}

test("standalone registration is idempotent, registration-only, and discovers on startup", () => {
  const fixture = host();
  piSettings(fixture.pi);
  piSettings(fixture.pi);
  expect([...fixture.commands.keys()]).toEqual(["pi-settings"]);
  expect([...fixture.lifecycle.keys()]).toEqual([
    "session_start",
    "session_shutdown",
  ]);
  expect(fixture.calls).toEqual(["pi-settings:v1:request"]);
  fixture.lifecycle.get("session_start")?.();
  expect(fixture.calls).toHaveLength(2);
  const shutdown = fixture.lifecycle.get("session_shutdown");
  shutdown?.();
  shutdown?.();
  expect(
    [...fixture.channels.values()].every((handlers) => handlers.size === 0),
  ).toBe(true);
  expect(fixture.lifecycle.size).toBe(0);
});

test("print/json/rpc invocation never opens an overlay or inspects configuration", async () => {
  const fixture = host();
  piSettings(fixture.pi);
  const messages: string[] = [];
  for (const mode of ["print", "json", "rpc"] as const) {
    const ctx = {
      mode,
      ui: {
        notify: (message: string) => messages.push(message),
        custom: () => {
          throw new Error("Non-TUI must not render");
        },
      },
    } as unknown as ExtensionCommandContext;
    await fixture.commands.get("pi-settings")?.handler("", ctx);
  }
  expect(messages).toHaveLength(3);
  expect(
    messages.every((message) =>
      message.includes("No configuration was changed"),
    ),
  ).toBe(true);
  fixture.lifecycle.get("session_shutdown")?.();
});

test("each TUI invocation owns a fresh full-viewport overlay without renderer changes", async () => {
  const fixture = host();
  piSettings(fixture.pi);
  const factories: unknown[] = [];
  const options: unknown[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      notify: () => {
        throw new Error("Unexpected failure notification");
      },
      custom: async (factory: unknown, option: unknown) => {
        factories.push(factory);
        options.push(option);
      },
    },
  } as unknown as ExtensionCommandContext;
  await fixture.commands.get("pi-settings")?.handler("", ctx);
  await fixture.commands.get("pi-settings")?.handler("", ctx);
  expect(factories).toHaveLength(2);
  expect(factories[0]).not.toBe(factories[1]);
  expect(options).toEqual(
    [0, 1].map(() => ({
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left",
        margin: 0,
      },
    })),
  );
  fixture.lifecycle.get("session_shutdown")?.();
});
