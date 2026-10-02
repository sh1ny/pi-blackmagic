import type {
  FieldSchema,
  JsonValue,
  SettingDescriptor,
  ValueSchema,
} from "./contracts.ts";

export const BASELINE_VERSION = "0.99.1";
export const NATIVE_PAGES = [
  "General",
  "Appearance",
  "Models",
  "Context",
  "Tools",
] as const;
export type NativePage = (typeof NATIVE_PAGES)[number];

const boolean: ValueSchema = { kind: "boolean" };
const text: ValueSchema = { kind: "text" };
const strings: ValueSchema = { kind: "list", item: text };
const number = (minimum = 0, maximum?: number): ValueSchema => ({
  kind: "number",
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
const integer = (
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): ValueSchema => ({ kind: "number", minimum, maximum, integer: true });
const choice = (
  ...values: (string | number | boolean | null)[]
): ValueSchema => ({ kind: "choice", values });
const thinking = choice(
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
);
const field = (schema: ValueSchema, description: string): FieldSchema => ({
  schema,
  description,
  required: false,
  sensitivity: "public",
});
const packageSource: ValueSchema = {
  kind: "union",
  variants: [
    text,
    {
      kind: "structured",
      preserveUnknown: true,
      fields: {
        source: {
          ...field({ kind: "text", minLength: 1 }, "Package source"),
          required: true,
        },
        autoload: field(boolean, "Automatically load package resources"),
        extensions: field(strings, "Extension filters"),
        skills: field(strings, "Skill filters"),
        prompts: field(strings, "Prompt filters"),
        themes: field(strings, "Theme filters"),
      },
    },
  ],
};
const compactionOverride: ValueSchema = {
  kind: "structured",
  preserveUnknown: true,
  fields: {
    reserveTokens: field(integer(), "Tokens reserved for model responses"),
    keepRecentTokens: field(
      integer(),
      "Recent tokens retained without summarization",
    ),
  },
};

interface Definition {
  path: string;
  page: NativePage;
  schema: ValueSchema;
  description: string;
  defaultValue?: JsonValue;
  userOnly?: boolean;
}
const definitions: Definition[] = [];
function add(
  page: NativePage,
  path: string,
  schema: ValueSchema,
  description: string,
  defaultValue?: JsonValue,
  userOnly = false,
): void {
  definitions.push({
    page,
    path,
    schema,
    description,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    userOnly,
  });
}

add(
  "Models",
  "defaultProvider",
  text,
  "Startup AI provider; does not select the current session model.",
);
add(
  "Models",
  "defaultModel",
  text,
  "Startup model ID; does not select the current session model.",
);
add(
  "Models",
  "defaultThinkingLevel",
  thinking,
  "Startup thinking level.",
  "medium",
);
add(
  "Models",
  "modelThinkingLevels",
  { kind: "map", value: thinking },
  "Per-model startup thinking levels keyed by provider/modelId.",
  {},
);
for (const level of ["minimal", "low", "medium", "high"])
  add(
    "Models",
    `thinkingBudgets.${level}`,
    integer(),
    `Token budget for ${level} thinking.`,
  );
add(
  "Models",
  "enabledModels",
  strings,
  "Model patterns for startup selection and cycling.",
);
add(
  "Appearance",
  "hideThinkingBlock",
  boolean,
  "Hide thinking blocks in the transcript.",
  false,
);
add(
  "Appearance",
  "showCacheMissNotices",
  boolean,
  "Show cache misses, warming, compaction usage, and recovery notices.",
  false,
);
add(
  "Models",
  "cacheWarming",
  choice("off", "streaming", "idle"),
  "Provider prompt-cache warming policy; user scope only.",
  "streaming",
  true,
);
for (const path of ["steeringMode", "followUpMode"])
  add(
    "General",
    path,
    choice("all", "one-at-a-time"),
    `Delivery policy for queued ${path === "steeringMode" ? "steering" : "follow-up"} messages.`,
    "one-at-a-time",
  );
add(
  "General",
  "externalEditor",
  text,
  "External editor command; otherwise VISUAL, EDITOR, or platform default.",
);
add(
  "General",
  "doubleEscapeAction",
  choice("tree", "fork", "none"),
  "Double Escape action with an empty editor.",
  "tree",
);
add(
  "General",
  "treeFilterMode",
  choice("default", "no-tools", "user-only", "labeled-only", "all"),
  "Initial session-tree filter.",
  "default",
);
add(
  "General",
  "defaultProjectTrust",
  choice("ask", "always", "never"),
  "Fallback project-trust behavior; user scope only.",
  "ask",
  true,
);
add(
  "Tools",
  "defaultTools",
  strings,
  "Startup tool selection: plain names replace; +name adds; -name removes.",
  ["read", "bash", "edit", "write"],
);
add(
  "Tools",
  "codemode.mode",
  choice("on", "only"),
  "Tool declaration exposure while codemode is active.",
  "on",
);
add(
  "Tools",
  "codemode.inlineBudget",
  number(),
  "Estimated token budget for inline codemode declarations.",
  3000,
);
add(
  "Context",
  "sessionDir",
  text,
  "Session storage directory; CLI and environment may override. Project access remains trust-gated here.",
);
add(
  "Context",
  "compaction.enabled",
  boolean,
  "Enable automatic compaction.",
  true,
);
add(
  "Context",
  "compaction.reserveTokens",
  integer(),
  "Tokens reserved for the model response.",
  16384,
);
add(
  "Context",
  "compaction.keepRecentTokens",
  integer(),
  "Recent tokens retained without summarization.",
  20000,
);
add(
  "Context",
  "compaction.modelOverrides",
  { kind: "map", value: compactionOverride },
  "Per-model compaction token settings; each field inherits independently.",
  {},
);
add(
  "Context",
  "branchSummary.reserveTokens",
  number(),
  "Tokens reserved for branch summaries.",
  16384,
);
add(
  "Context",
  "branchSummary.skipPrompt",
  boolean,
  "Skip branch-summary prompting and default to no summary.",
  false,
);
add(
  "Appearance",
  "theme",
  text,
  "Built-in or custom theme name; system follows terminal colors.",
  "system",
);
add("Appearance", "quietStartup", boolean, "Hide the startup header.", false);
add(
  "Appearance",
  "tuiMode",
  choice("regular", "fullscreen"),
  "Interactive terminal renderer mode.",
  "regular",
);
add(
  "Appearance",
  "fullscreenExitOutput",
  choice("transcript", "resume-hint"),
  "Output printed when fullscreen mode exits.",
  "transcript",
);
add(
  "Appearance",
  "fullscreenScrollbar",
  choice("auto", "always", "hidden"),
  "Fullscreen transcript scrollbar behavior.",
  "auto",
);
add(
  "Appearance",
  "fullscreenCopyOnSelect",
  boolean,
  "Automatically copy fullscreen selections.",
  true,
);
add(
  "Appearance",
  "fullscreenWheelScrollLines",
  { kind: "union", variants: [choice("auto"), integer(1, 100)] },
  "Mouse-wheel lines per event; auto adapts to the terminal.",
  "auto",
);
add(
  "Appearance",
  "editorPaddingX",
  integer(0, 3),
  "Horizontal editor padding in cells.",
  0,
);
add(
  "Appearance",
  "outputPad",
  choice(0, 1),
  "Horizontal transcript padding.",
  1,
);
add(
  "Appearance",
  "autocompleteMaxVisible",
  integer(3, 20),
  "Maximum visible autocomplete entries.",
  5,
);
add(
  "Appearance",
  "showHardwareCursor",
  boolean,
  "Show the terminal cursor for input methods.",
  false,
);
add(
  "Appearance",
  "terminal.showImages",
  boolean,
  "Display inline images when supported.",
  true,
);
add(
  "Appearance",
  "terminal.imageWidthCells",
  integer(1),
  "Preferred inline-image width in cells.",
  60,
);
add(
  "Appearance",
  "terminal.clearOnShrink",
  boolean,
  "Clear empty rows when rendered content shrinks.",
  false,
);
add(
  "Appearance",
  "terminal.showTerminalProgress",
  boolean,
  "Show OSC 9;4 terminal progress.",
  false,
);
for (const path of ["hyperlinks", "trueColor"])
  add(
    "Appearance",
    `terminal.${path}`,
    choice(true, false, "auto"),
    `Override terminal ${path} capability detection.`,
    "auto",
  );
add(
  "Appearance",
  "terminal.images",
  choice("kitty", "iterm2", "auto", false),
  "Override inline-image protocol detection.",
  "auto",
);
add(
  "Models",
  "images.autoResize",
  boolean,
  "Resize images before sending them to models.",
  true,
);
add(
  "Models",
  "images.blockImages",
  boolean,
  "Prevent images from being sent to models.",
  false,
);
add(
  "Appearance",
  "markdown.codeBlockIndent",
  text,
  "Prefix for rendered code-block indentation.",
  "  ",
);
add(
  "Appearance",
  "markdown.mermaid",
  choice("off", "final", "streaming"),
  "Mermaid diagram rendering mode.",
  "streaming",
);
add(
  "Models",
  "transport",
  choice("auto", "sse", "websocket", "websocket-cached"),
  "Preferred supported provider transport.",
  "auto",
);
add(
  "General",
  "httpProxy",
  text,
  "Proxy URL for Pi-managed HTTP clients; user scope only.",
  undefined,
  true,
);
add(
  "General",
  "httpIdleTimeoutMs",
  number(),
  "HTTP header/body idle timeout in milliseconds; zero disables.",
  300000,
);
add(
  "General",
  "websocketConnectTimeoutMs",
  number(),
  "WebSocket connection timeout in milliseconds; zero disables.",
  15000,
);
add(
  "Models",
  "retry.enabled",
  boolean,
  "Enable agent-level retries for transient failures.",
  true,
);
add(
  "Models",
  "retry.maxRetries",
  integer(),
  "Maximum agent-level retry attempts.",
  3,
);
add(
  "Models",
  "retry.baseDelayMs",
  number(),
  "Initial exponential-backoff delay in milliseconds.",
  2000,
);
add(
  "Models",
  "retry.maxAgentDelayMs",
  number(),
  "Maximum agent-level retry delay in milliseconds.",
  60000,
);
add(
  "Models",
  "retry.provider.timeoutMs",
  number(),
  "Provider request timeout; inherits HTTP idle timeout.",
);
add(
  "Models",
  "retry.provider.maxRetries",
  integer(),
  "Provider retry attempts; normally keep at zero.",
  0,
);
add(
  "Models",
  "retry.provider.maxRetryDelayMs",
  number(),
  "Maximum server-requested retry delay; zero disables the limit.",
  60000,
);
add(
  "Tools",
  "shellPath",
  text,
  "Custom shell executable; supports a leading tilde.",
);
add("Tools", "shellCommandPrefix", text, "Prefix prepended to shell commands.");
add(
  "Tools",
  "npmCommand",
  strings,
  "npm package lookup/install command and arguments.",
  ["npm"],
);
add(
  "Tools",
  "packages",
  { kind: "list", item: packageSource },
  "Package sources and resource filters; user and project resources combine.",
  [],
);
for (const path of ["extensions", "skills", "prompts", "themes"])
  add(
    "Tools",
    path,
    strings,
    `${path} resource paths; preserve glob exclusions and exact inclusions/exclusions.`,
    [],
  );
add(
  "Tools",
  "enableSkillCommands",
  boolean,
  "Register skills as slash commands.",
  true,
);
add(
  "General",
  "collapseChangelog",
  boolean,
  "Show a condensed changelog after updates.",
  false,
);
add(
  "General",
  "enableInstallTelemetry",
  boolean,
  "Anonymous install/update reporting and provider attribution headers.",
  true,
);
add(
  "General",
  "enableAnalytics",
  boolean,
  "Opt in to analytics data sharing.",
  false,
);
add(
  "General",
  "warnings.anthropicExtraUsage",
  boolean,
  "Warn when subscription authentication may use paid extra usage.",
  true,
);

export const NATIVE_DESCRIPTORS: readonly SettingDescriptor[] = definitions.map(
  (entry) => ({
    id: `native.${entry.path}`,
    providerId: "native",
    pageId: entry.page,
    path: entry.path.split("."),
    label: entry.path,
    description: entry.description,
    sourceLabel: entry.page,
    schema: entry.schema,
    scopes: entry.userOnly ? ["user"] : ["user", "project"],
    sensitivity: entry.path === "httpProxy" ? "masked" : "public",
    activation: entry.path === "theme" ? "immediate" : "reload",
  }),
);

/** Missing entries have host-/environment-dependent defaults, not invented values. */
export const NATIVE_DEFAULTS: Readonly<Record<string, JsonValue>> =
  Object.fromEntries(
    definitions
      .filter((entry) => entry.defaultValue !== undefined)
      .map((entry) => [entry.path, entry.defaultValue as JsonValue]),
  );
export const EXCLUDED_NATIVE_FIELDS = [
  "deviceId",
  "lastChangelogVersion",
  "trackingId",
] as const;
