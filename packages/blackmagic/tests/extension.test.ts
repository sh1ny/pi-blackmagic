import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import blackmagic, { composeExtensions } from "../src/index.ts";

test("the suite independently registers the settings command once without reading configuration", () => {
  const commands: string[] = [];
  const handlers = new Map<string, () => void>();
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    },
    registerCommand: (name: string) => commands.push(name),
    getSettings: () => {
      throw new Error("No factory-time configuration reads");
    },
  } as unknown as ExtensionAPI;
  expect(blackmagic(pi)).toBeUndefined();
  blackmagic(pi);
  expect(commands).toEqual(["pi-settings"]);
  handlers.get("session_shutdown")?.();
});

test("one composition invocation calls its member once with the same API", () => {
  const pi = {} as ExtensionAPI;
  const received: ExtensionAPI[] = [];

  composeExtensions(pi, [
    (api) => {
      received.push(api);
    },
  ]);

  expect(received).toHaveLength(1);
  expect(received[0]).toBe(pi);
});

test("composition initializes every supplied member once", () => {
  const pi = {} as ExtensionAPI;
  const calls: string[] = [];
  const member = (name: string) => (api: ExtensionAPI) => {
    expect(api).toBe(pi);
    calls.push(name);
  };

  composeExtensions(pi, [member("first"), member("second")]);

  expect(calls).toEqual(["first", "second"]);
});
