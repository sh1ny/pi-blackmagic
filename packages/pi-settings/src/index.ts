import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CenterCatalog } from "./center-catalog.ts";
import type { JsonValue } from "./contracts.ts";
import { SettingsCenterPanel } from "./panel.ts";
import { SettingsRegistry } from "./registry.ts";
import { isJsonValue } from "./validation.ts";

const initialized = new WeakSet<ExtensionAPI>();

/** Independently loadable extension; initialization only registers command/events and protocol listeners. */
export default function piSettings(pi: ExtensionAPI): void {
  if (initialized.has(pi)) return;
  initialized.add(pi);
  const registry = new SettingsRegistry(pi.events);
  let active: SettingsCenterPanel | undefined;
  let catalog: CenterCatalog | undefined;
  let opening = false;
  let disposed = false;
  const offRegistry = registry.subscribe((change) => {
    if (change.type === "registered" || change.type === "withdrawn") {
      void catalog?.refresh();
    }
  });
  const listeners: (() => void)[] = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    offRegistry();
    catalog?.dispose();
    active?.dispose();
    catalog = undefined;
    active = undefined;
    registry.dispose();
    for (const off of listeners) off();
    initialized.delete(pi);
  };
  listeners.push(pi.on("session_start", () => registry.open()));
  listeners.push(pi.on("session_shutdown", dispose));

  pi.registerCommand("pi-settings", {
    description:
      "Open the full-screen, scoped settings center (valid completed edits autosave)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "/pi-settings requires interactive terminal mode. No configuration was changed.",
          "warning",
        );
        return;
      }
      if (disposed || opening) return;
      opening = true;
      registry.open();
      try {
        await ctx.ui.custom<void>(
          async (tui, _theme, keybindings, done) => {
            if (disposed) throw new Error("Settings center is unavailable.");
            catalog = new CenterCatalog({
              context: ctx,
              registry,
              keybindings,
              ...(ctx.modelRegistry ? { modelCatalog: ctx.modelRegistry } : {}),
              hostSettings: () => {
                const value: unknown = pi.getSettings();
                return isJsonValue(value) &&
                  value !== null &&
                  typeof value === "object" &&
                  !Array.isArray(value)
                  ? (value as Record<string, JsonValue>)
                  : {};
              },
              applyTheme: (name) => ctx.ui.setTheme(name),
              onChange: () => active?.setRows(catalog?.rows() ?? []),
            });
            await catalog.refresh();
            if (disposed) throw new Error("Settings center is unavailable.");
            active = new SettingsCenterPanel(
              catalog.rows(),
              tui,
              () => ctx.ui.theme,
              () => done(),
            );
            return active;
          },
          {
            overlay: true,
            overlayOptions: {
              width: "100%",
              maxHeight: "100%",
              anchor: "top-left",
              margin: 0,
            },
          },
        );
      } catch {
        if (!disposed)
          ctx.ui.notify(
            "Settings center could not be opened. Sensitive diagnostic details were withheld.",
            "error",
          );
      } finally {
        active?.dispose();
        catalog?.dispose();
        active = undefined;
        catalog = undefined;
        opening = false;
      }
    },
  });
}
