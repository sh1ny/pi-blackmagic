import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Scope } from "./contracts.ts";

export type ConfigurationKind = "native" | "keybindings" | "mcp" | "models";
export interface ProjectContext {
  cwd: string;
  isProjectTrusted(): boolean;
}
export type ConfigurationPath =
  | { state: "available"; path: string; scope: Scope }
  | { state: "unavailable"; scope: Scope; reason: string };

const filenames: Record<ConfigurationKind, string> = {
  native: "settings.json",
  keybindings: "keybindings.json",
  mcp: "mcp.json",
  models: "models.json",
};

/** Resolves only: this function never reads or creates directories, files, or trust decisions. */
export function resolveConfigurationPath(
  kind: ConfigurationKind,
  scope: Scope,
  context: ProjectContext,
  agentDirectory: () => string = getAgentDir,
): ConfigurationPath {
  if (scope === "project") {
    if (kind === "keybindings" || kind === "models")
      return {
        state: "unavailable",
        scope,
        reason: "This configuration supports user scope only.",
      };
    if (!context.isProjectTrusted())
      return {
        state: "unavailable",
        scope,
        reason:
          "Project configuration is unavailable until the host reports this project trusted.",
      };
    return {
      state: "available",
      scope,
      path: join(resolve(context.cwd), ".pi", filenames[kind]),
    };
  }
  return {
    state: "available",
    scope,
    path: join(resolve(agentDirectory()), filenames[kind]),
  };
}
