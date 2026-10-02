import type {
  FieldSchema,
  JsonValue,
  ValidationResult,
  ValueSchema,
} from "./contracts.ts";
import { isJsonValue, validateValue } from "./validation.ts";

// Reviewed against Pi 0.99.1 core/mcp-servers.{js,d.ts} and extensions/mcp/config.js.
// This module deliberately imports no host MCP code: validation never resolves credentials.
const text: ValueSchema = { kind: "text" };
const strings: ValueSchema = { kind: "map", value: text };
export const MCP_EXPOSURES = [
  "codemode",
  "codemode-deferred",
  "deferred",
  "direct",
  "hidden",
] as const;
const exposure: ValueSchema = { kind: "choice", values: MCP_EXPOSURES };
function field(
  schema: ValueSchema,
  description: string,
  sensitivity: "public" | "masked" = "public",
  required = false,
): FieldSchema {
  return { schema, description, sensitivity, required };
}
export const MCP_OAUTH_SCHEMA: ValueSchema = {
  kind: "structured",
  preserveUnknown: true,
  fields: {
    clientId: field(
      text,
      "Pre-registered OAuth client ID; absent means dynamic registration.",
    ),
    clientSecret: field(
      text,
      "Literal secret, environment reference, or !command expression; never evaluated here.",
      "masked",
    ),
    callbackPort: field(
      { kind: "number", integer: true, minimum: 1, maximum: 65535 },
      "Fixed loopback callback port.",
    ),
    callbackUrl: field(
      text,
      "HTTP loopback redirect URI without query or fragment.",
    ),
    scope: field(text, "Space-separated requested OAuth scopes."),
  },
};
const common: Record<string, FieldSchema> = {
  enabled: field({ kind: "boolean" }, "Connect on reload; default true."),
  exposure: field(exposure, "Default tool exposure; default codemode."),
  toolExposure: field(
    { kind: "map", value: exposure },
    "Exact tool names win over wildcard patterns; the first matching pattern wins.",
  ),
  timeout: field(
    { kind: "number", exclusiveMinimum: 0 },
    "Positive request timeout in seconds; default 60. Progress resets it.",
  ),
};
const stdio: Record<string, FieldSchema> = {
  command: field(
    text,
    "Server executable; stored literally, not launched here.",
  ),
  args: field({ kind: "list", item: text }, "Ordered executable arguments."),
  env: field(
    strings,
    "Environment values, including literal environment and !command references.",
  ),
  cwd: field(
    text,
    "Working directory; relative paths resolve against the session directory.",
  ),
};
const http: Record<string, FieldSchema> = {
  url: field(text, "Streamable HTTP endpoint using http or https."),
  headers: field(
    strings,
    "HTTP header values, including literal credential references.",
  ),
  oauth: field(
    MCP_OAUTH_SCHEMA,
    "OAuth client settings; authentication state is not edited here.",
  ),
};
export const MCP_STDIO_SCHEMA: ValueSchema = {
  kind: "structured",
  preserveUnknown: true,
  fields: {
    ...common,
    ...stdio,
    type: field(
      { kind: "choice", values: ["stdio"] },
      "Optional stdio transport tag.",
    ),
    command: field(
      text,
      "Server executable; stored literally, not launched here.",
      "public",
      true,
    ),
  },
};
export const MCP_HTTP_SCHEMA: ValueSchema = {
  kind: "structured",
  preserveUnknown: true,
  fields: {
    ...common,
    ...http,
    type: field(
      { kind: "choice", values: ["http", "streamable-http"] },
      "Optional HTTP tag; streamable-http is a baseline runtime alias.",
    ),
    url: field(
      text,
      "Streamable HTTP endpoint using http or https.",
      "public",
      true,
    ),
  },
};
/** All editable fields are explicit; required transport fields are checked cross-field below. */
export const MCP_SERVER_SCHEMA: ValueSchema = {
  kind: "structured",
  preserveUnknown: true,
  fields: {
    ...common,
    ...stdio,
    ...http,
    type: field(
      { kind: "choice", values: ["stdio", "http", "streamable-http"] },
      "Optional transport tag. Legacy SSE is unsupported.",
    ),
  },
};
export const MCP_SCHEMA: ValueSchema = {
  kind: "structured",
  preserveUnknown: true,
  fields: {
    autoEnableCodemode: field(
      { kind: "boolean" },
      "Automatically enable codemode when codemode-exposed servers connect; default true.",
    ),
    mcpServers: field(
      { kind: "map", value: MCP_SERVER_SCHEMA },
      "Named servers; project entries replace user entries in full.",
    ),
  },
};
const invalid: ValidationResult = {
  valid: false,
  message:
    "MCP configuration does not match the supported schema or transport constraints.",
};
function object(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validateMcpServerName(name: string): ValidationResult {
  return /^[A-Za-z0-9_-]+$/.test(name)
    ? { valid: true }
    : {
        valid: false,
        message:
          "Server names must contain only letters, digits, underscores, or hyphens.",
      };
}
export function isMcpLoopbackRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
export function validateMcpOAuth(value: unknown): ValidationResult {
  if (
    !isJsonValue(value) ||
    !validateValue(MCP_OAUTH_SCHEMA, value).valid ||
    !object(value)
  )
    return invalid;
  if (value.callbackUrl !== undefined) {
    if (
      typeof value.callbackUrl !== "string" ||
      !isMcpLoopbackRedirectUri(value.callbackUrl)
    )
      return invalid;
    const port = new URL(value.callbackUrl).port;
    if (
      port &&
      value.callbackPort !== undefined &&
      Number(port) !== value.callbackPort
    )
      return invalid;
  }
  return { valid: true };
}
export function validateMcpServer(
  name: string,
  value: unknown,
): ValidationResult {
  if (
    !validateMcpServerName(name).valid ||
    !isJsonValue(value) ||
    !validateValue(MCP_SERVER_SCHEMA, value).valid ||
    !object(value)
  )
    return invalid;
  const has = (key: string) => Object.hasOwn(value, key);
  if (has("url")) {
    if (
      !validateValue(MCP_HTTP_SCHEMA, value).valid ||
      ["command", "args", "env", "cwd"].some(has)
    )
      return invalid;
    try {
      if (!/^https?:$/.test(new URL(value.url as string).protocol))
        return invalid;
    } catch {
      return invalid;
    }
    if (has("oauth") && !validateMcpOAuth(value.oauth).valid) return invalid;
  } else {
    if (
      !validateValue(MCP_STDIO_SCHEMA, value).valid ||
      ["headers", "oauth"].some(has)
    )
      return invalid;
  }
  return { valid: true };
}
export function validateMcpConfiguration(value: unknown): ValidationResult {
  if (
    !isJsonValue(value) ||
    !validateValue(MCP_SCHEMA, value).valid ||
    !object(value)
  )
    return invalid;
  if (object(value.mcpServers ?? null)) {
    for (const [name, entry] of Object.entries(
      value.mcpServers as Record<string, JsonValue>,
    )) {
      if (!validateMcpServer(name, entry).valid) return invalid;
    }
  }
  return { valid: true };
}
export function validateMcpRootOption(
  name: string,
  value: unknown,
): ValidationResult {
  return name === "autoEnableCodemode" && typeof value === "boolean"
    ? { valid: true }
    : invalid;
}
