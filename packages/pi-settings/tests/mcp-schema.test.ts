import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { JsonValue, SettingDescriptor } from "../src/contracts.ts";
import { descriptorCoverage } from "../src/coverage.ts";
import {
  MCP_EXPOSURES,
  MCP_SCHEMA,
  validateMcpConfiguration,
  validateMcpOAuth,
  validateMcpRootOption,
  validateMcpServer,
  validateMcpServerName,
} from "../src/mcp-schema.ts";
import coverage from "./fixtures/pi-0.99.1-coverage.json";

const stdio: Record<string, JsonValue> = {
  type: "stdio",
  command: "not-a-real-command",
  args: ["--flag", `\${LITERAL}`],
  env: { TOKEN: "!not-a-real-credential-command" },
  cwd: "relative/path",
  enabled: false,
  exposure: "codemode-deferred",
  toolExposure: { "read_*": "direct", private: "hidden" },
  timeout: 0.25,
};
const http: Record<string, JsonValue> = {
  type: "http",
  url: "https://example.invalid/mcp",
  headers: { Authorization: `Bearer \${TOKEN}` },
  oauth: {
    clientId: "synthetic-client",
    clientSecret: "!not-a-real-credential-command",
    callbackPort: 8080,
    callbackUrl: "http://localhost:8080/oauth/callback",
    scope: "read write",
  },
  enabled: true,
  exposure: "deferred",
  toolExposure: { "*": "codemode" },
  timeout: 60,
};

// Every baseline field has both a valid example and a type-invalid example, including dynamic values.
const invalidFields: Array<[string[], JsonValue]> = [
  [["type"], "sse"],
  [["command"], 1],
  [["args"], [1]],
  [["env"], { TOKEN: 1 }],
  [["cwd"], false],
  [["enabled"], "yes"],
  [["exposure"], "unknown"],
  [["toolExposure"], { "*": "unknown" }],
  [["timeout"], 0],
  [["url"], 1],
  [["headers"], { Authorization: false }],
  [["oauth"], []],
  [["oauth", "clientId"], 1],
  [["oauth", "clientSecret"], false],
  [["oauth", "callbackPort"], 1.5],
  [["oauth", "callbackUrl"], false],
  [["oauth", "scope"], []],
];
function set(
  root: Record<string, JsonValue>,
  path: string[],
  value: JsonValue,
) {
  const key = path.at(-1) as string;
  let parent = root;
  for (const segment of path.slice(0, -1))
    parent = parent[segment] as Record<string, JsonValue>;
  parent[key] = value;
}

describe("local baseline MCP schema", () => {
  test("root descriptor covers the reviewed fixture, including every optional field", () => {
    const descriptor: SettingDescriptor = {
      id: "pi.mcp",
      providerId: "pi",
      pageId: "mcp",
      path: [],
      label: "MCP",
      description: "Baseline MCP configuration",
      sourceLabel: "MCP",
      schema: MCP_SCHEMA,
      scopes: ["user", "project"],
      sensitivity: "public",
      activation: "reload",
    };
    // The fixture inventories storage fields, not the synthetic root or primitive list-item nodes.
    const actual = descriptorCoverage([descriptor])
      .filter((path) => path !== "" && !path.endsWith("[]"))
      .map((path) => path.replace(/^\./, ""));
    expect(actual.sort()).toEqual([...coverage.mcp].sort());
    expect(
      validateMcpConfiguration({
        autoEnableCodemode: false,
        mcpServers: { local: stdio, remote: http },
      }).valid,
    ).toBe(true);
  });
  test("all optional fields accept valid and reject invalid values", () => {
    expect(validateMcpServer("local", stdio).valid).toBe(true);
    expect(validateMcpServer("remote", http).valid).toBe(true);
    for (const [path, value] of invalidFields) {
      const entry = structuredClone(
        ["url", "headers", "oauth"].includes(path[0] as string) ? http : stdio,
      );
      set(entry, path, value);
      expect(validateMcpServer("synthetic", entry).valid, path.join(".")).toBe(
        false,
      );
    }
    for (const value of MCP_EXPOSURES) {
      expect(
        validateMcpServer("test", {
          command: "literal",
          exposure: value,
          toolExposure: { "*": value },
        }).valid,
      ).toBe(true);
    }
  });
  test("implicit transports, runtime HTTP alias, optional OAuth, and unknown keys", () => {
    for (const entry of [
      { command: "literal" },
      { url: "http://example.invalid/mcp" },
      { type: "streamable-http", url: "https://example.invalid/mcp" },
      { url: "https://example.invalid/mcp", oauth: {} },
    ])
      expect(validateMcpServer("valid_123-Name", entry).valid).toBe(true);
    expect(
      validateMcpConfiguration({
        unknownFuture: { literal: true },
        mcpServers: { local: { ...stdio, future: { opaque: "secret" } } },
      }).valid,
    ).toBe(true);
    expect(
      validateMcpServer("test", {
        command: "literal",
        timeout: Number.POSITIVE_INFINITY,
      }).valid,
    ).toBe(false);
    expect(
      validateMcpServer("test", { command: "literal", timeout: Number.NaN })
        .valid,
    ).toBe(false);
  });
  test("names and cross-transport constraints", () => {
    for (const name of [
      "",
      "has space",
      "has.dot",
      "../path",
      "😀",
      "line\n",
      "a/b",
    ])
      expect(validateMcpServerName(name).valid).toBe(false);
    for (const entry of [
      null,
      [],
      {},
      { type: "sse", url: "https://example.invalid" },
      { type: "stdio", url: "https://example.invalid" },
      { type: "http", command: "literal" },
      { command: "literal", url: "https://example.invalid" },
      { command: "literal", headers: {} },
      { command: "literal", oauth: {} },
      { url: "https://example.invalid", args: [] },
      { url: "https://example.invalid", env: {} },
      { url: "https://example.invalid", cwd: "here" },
      { url: "file:///tmp/data" },
      { url: "not a URL" },
    ])
      expect(validateMcpServer("test", entry).valid).toBe(false);
  });
  test("OAuth integer ports, loopback requirements, mismatches, and free-port redirects", () => {
    for (const callbackUrl of [
      "http://localhost/callback",
      "http://127.0.0.1:8080/callback",
      "http://[::1]:8080/oauth/callback",
    ])
      expect(validateMcpOAuth({ callbackUrl, callbackPort: 8080 }).valid).toBe(
        true,
      );
    for (const callbackUrl of [
      "https://localhost/callback",
      "http://example.invalid:8080/callback",
      "http://127.0.0.2/callback",
      "http://localhost:8080/callback?q=secret",
      "http://localhost:8080/callback#secret",
      "invalid",
      "http://localhost:8081/callback",
    ])
      expect(validateMcpOAuth({ callbackUrl, callbackPort: 8080 }).valid).toBe(
        false,
      );
    for (const callbackPort of [0, 65536, -1, 0.5, "8080", null])
      expect(validateMcpOAuth({ callbackPort }).valid).toBe(false);
    for (const callbackPort of [1, 65535])
      expect(validateMcpOAuth({ callbackPort }).valid).toBe(true);
    // URL normalizes explicit :80 to an absent port, matching the host's baseline check.
    expect(
      validateMcpOAuth({
        callbackUrl: "http://localhost:80/callback",
        callbackPort: 8080,
      }).valid,
    ).toBe(true);
  });
  test("invalid roots and unsupported root options", () => {
    for (const root of [
      null,
      [],
      1,
      { mcpServers: [] },
      { mcpServers: null },
      { autoEnableCodemode: "true" },
      { mcpServers: { "bad name": stdio } },
    ])
      expect(validateMcpConfiguration(root).valid).toBe(false);
    expect(validateMcpConfiguration({}).valid).toBe(true);
    expect(validateMcpRootOption("autoEnableCodemode", true).valid).toBe(true);
    expect(validateMcpRootOption("autoEnableCodemode", false).valid).toBe(true);
    expect(validateMcpRootOption("autoEnableCodemode", 1).valid).toBe(false);
    expect(validateMcpRootOption("unknownFuture", true).valid).toBe(false);
  });
  test("validation diagnostics do not echo supplied secret fields or names", () => {
    const secret = "SYNTHETIC_DIAGNOSTIC_SECRET";
    expect(
      JSON.stringify(
        validateMcpServer(`${secret}.`, {
          url: secret,
          oauth: { clientSecret: secret },
        }),
      ),
    ).not.toContain(secret);
    expect(
      JSON.stringify(validateMcpOAuth({ callbackUrl: secret })),
    ).not.toContain(secret);
  });
  test("schema/backend have no MCP runtime, credential, network, or process imports", async () => {
    for (const filename of ["mcp-schema.ts", "mcp-backend.ts"]) {
      const source = await readFile(
        new URL(`../src/${filename}`, import.meta.url),
        "utf8",
      );
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (match) => match[1],
      );
      expect(imports.every((name) => name?.startsWith("./"))).toBe(true);
      expect(source).not.toMatch(
        /\b(fetch|spawn|exec|connect|loadMcpConfig|validateMcpServerConfig)\s*\(/,
      );
    }
  });
});
