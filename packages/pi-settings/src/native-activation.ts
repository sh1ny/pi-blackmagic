import type { ActivationRequirement, ActivationResult } from "./contracts.ts";
import { NATIVE_DESCRIPTORS } from "./native-catalog.ts";

const restartPaths = new Set([
  "tuiMode",
  "sessionDir",
  "httpProxy",
  "httpIdleTimeoutMs",
  "websocketConnectTimeoutMs",
  "defaultProjectTrust",
]);
/** Every baseline descriptor has an explicit policy; runtime defaults are never session setters. */
export const NATIVE_ACTIVATION: Readonly<
  Record<string, ActivationRequirement>
> = Object.fromEntries(
  NATIVE_DESCRIPTORS.map((descriptor) => [
    descriptor.id,
    descriptor.path.join(".") === "theme"
      ? "immediate"
      : restartPaths.has(descriptor.path.join("."))
        ? "restart"
        : "reload",
  ]),
);

export async function activateNative(
  descriptorId: string,
  value: unknown,
  applyTheme?: (
    theme: string,
  ) => Promise<{ success: boolean }> | { success: boolean },
): Promise<ActivationResult> {
  const policy = NATIVE_ACTIVATION[descriptorId] ?? "reload";
  if (policy !== "immediate") return { state: "required", requirement: policy };
  if (typeof value !== "string" || !applyTheme)
    return { state: "required", requirement: "reload" };
  try {
    if ((await applyTheme(value)).success) return { state: "active" };
  } catch {
    /* Runtime errors cannot undo an acknowledged disk write or leak credential text. */
  }
  return {
    state: "failed",
    requirement: "reload",
    message:
      "Configuration saved, but the theme could not be applied. Reload explicitly.",
  };
}
