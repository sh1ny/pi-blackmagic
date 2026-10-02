import { readFile } from "node:fs/promises";
import type { JsonValue } from "./contracts.ts";
import type { ConfigurationPath } from "./paths.ts";
import { stripJsonComments } from "./json-comments.ts";

export type ConfigurationRead =
  | { state: "available"; exists: boolean; value: Record<string, JsonValue> }
  | { state: "unavailable"; reason: string }
  | { state: "error"; message: string };

/** Reads only an available path. Missing configuration is empty, never materialized. */
export async function readConfiguration(
  location: ConfigurationPath,
  allowComments = false,
): Promise<ConfigurationRead> {
  if (location.state === "unavailable")
    return { state: "unavailable", reason: location.reason };
  let content: string;
  try {
    content = await readFile(location.path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT"))
      return { state: "available", exists: false, value: {} };
    return { state: "error", message: "Configuration could not be read." };
  }
  try {
    const text = content.replace(/^\uFEFF/, "");
    const value: unknown = JSON.parse(
      allowComments ? stripJsonComments(text) : text,
    );
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return {
        state: "error",
        message: "Configuration must be a JSON object.",
      };
    return {
      state: "available",
      exists: true,
      value: value as Record<string, JsonValue>,
    };
  } catch {
    return {
      state: "error",
      message: "Configuration is malformed; repair the file before editing.",
    };
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
