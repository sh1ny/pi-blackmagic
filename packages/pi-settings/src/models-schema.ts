import type {
  FieldSchema,
  SettingDescriptor,
  ValueSchema,
} from "./contracts.ts";

// Reviewed against Pi 0.99.1 dist/core/model-config.js. No host schema is evaluated.
const text: ValueSchema = { kind: "text" };
const named: ValueSchema = { kind: "text", minLength: 1 };
const number: ValueSchema = { kind: "number" };
const boolean: ValueSchema = { kind: "boolean" };
const positiveInteger: ValueSchema = {
  kind: "number",
  integer: true,
  minimum: 1,
};
const choice = (...values: (string | null)[]): ValueSchema => ({
  kind: "choice",
  values,
});
const union = (...variants: ValueSchema[]): ValueSchema => ({
  kind: "union",
  variants,
});
const list = (item: ValueSchema, maxItems?: number): ValueSchema => ({
  kind: "list",
  item,
  ...(maxItems === undefined ? {} : { maxItems }),
});
const map = (value: ValueSchema): ValueSchema => ({ kind: "map", value });
function field(
  schema: ValueSchema,
  description: string,
  required = false,
  masked = false,
): FieldSchema {
  return {
    schema,
    description,
    required,
    sensitivity: masked ? "masked" : "public",
  };
}
function object(fields: Record<string, FieldSchema>): ValueSchema {
  return {
    kind: "structured",
    fields: Object.assign(Object.create(null), fields),
    preserveUnknown: true,
  };
}
function fields(
  names: readonly string[],
  schema: ValueSchema,
  description: string,
  required = false,
): Record<string, FieldSchema> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      field(schema, `${description}: ${name}.`, required),
    ]),
  );
}
const percentile = object(
  fields(["p50", "p75", "p90", "p99"], number, "Routing percentile cutoff"),
);
const routing = object({
  ...fields(
    [
      "allow_fallbacks",
      "require_parameters",
      "zdr",
      "enforce_distillable_text",
    ],
    boolean,
    "OpenRouter routing flag",
  ),
  data_collection: field(
    choice("deny", "allow"),
    "OpenRouter data collection policy.",
  ),
  ...fields(
    ["order", "only", "ignore", "quantizations"],
    list(text),
    "OpenRouter provider routing list",
  ),
  sort: field(
    union(
      text,
      object({
        by: field(text, "Routing sort key."),
        partition: field(
          union(text, choice(null)),
          "Optional partition or null.",
        ),
      }),
    ),
    "Routing sort string or structured sort.",
  ),
  max_price: field(
    object(
      fields(
        ["prompt", "completion", "image", "audio", "request"],
        union(number, text),
        "Maximum routing price",
      ),
    ),
    "OpenRouter maximum prices.",
  ),
  ...fields(
    ["preferred_min_throughput", "preferred_max_latency"],
    union(number, percentile),
    "Preferred routing cutoff",
  ),
});
const thinkingLevelMap = object(
  fields(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    union(text, choice(null)),
    "Thinking effort mapping (null suppresses mapping)",
  ),
);
const chatTemplateValue = union(
  text,
  number,
  boolean,
  choice(null),
  object({
    $var: field(
      choice("thinking.enabled", "thinking.effort"),
      "Host thinking variable.",
      true,
    ),
    omitWhenOff: field(boolean, "Omit this variable when thinking is off."),
  }),
);
const costRateNames = ["input", "output", "cacheRead", "cacheWrite"];
const costTier = object({
  inputTokensAbove: field(number, "Input token threshold.", true),
  ...fields(costRateNames, number, "Cost rate", true),
});
const cost = (partial: boolean) =>
  object({
    ...fields(costRateNames, number, "Cost per million tokens", !partial),
    tiers: field(
      list(costTier),
      "Optional context-dependent cost tiers; each tier requires all rates and threshold.",
    ),
  });
const promptCache = object(
  fields(
    ["short", "long"],
    { kind: "number", exclusiveMinimum: 0 },
    "Positive prompt cache retention",
  ),
);
const inputLimits = object({
  maxRequestBytes: field(positiveInteger, "Maximum request size in bytes."),
  images: field(
    object({
      resize: field(
        object({
          ...fields(
            ["maxWidth", "maxHeight", "maxBytes"],
            positiveInteger,
            "Image resize limit",
          ),
          jpegQuality: field(
            { kind: "number", integer: true, minimum: 1, maximum: 100 },
            "JPEG quality from 1 to 100.",
          ),
        }),
        "Image resizing limits.",
      ),
      ...fields(
        ["maxPerMessage", "maxPerRequest"],
        positiveInteger,
        "Image count limit",
      ),
    }),
    "Image request limits.",
  ),
});

// The host's three optional-object union branches have no discriminator and allow
// additional properties. Use their complete known-field union so malformed known
// options cannot evade validation by matching a different, otherwise empty branch.
export const MODEL_COMPAT_SCHEMA: ValueSchema = object({
  ...fields(
    [
      "supportsStore",
      "supportsDeveloperRole",
      "supportsReasoningEffort",
      "supportsUsageInStreaming",
      "supportsFinishReason",
      "requiresToolResultName",
      "requiresAssistantAfterToolResult",
      "requiresThinkingAsText",
      "requiresReasoningContentOnAssistantMessages",
      "supportsOpenAIGrammarTools",
      "supportsStrictMode",
      "sendSessionAffinityHeaders",
      "supportsLongCacheRetention",
      "supportsMaxOutputTokens",
      "supportsEagerToolInputStreaming",
      "supportsCacheControlOnTools",
      "supportsTemperature",
      "forceAdaptiveThinking",
      "allowEmptySignature",
      "supportsStrictTools",
      "supportsMidConvoEffort",
    ],
    boolean,
    "Provider API compatibility flag",
  ),
  maxTokensField: field(
    choice("max_completion_tokens", "max_tokens"),
    "Completions token-limit request field.",
  ),
  thinkingFormat: field(
    choice(
      "openai",
      "openrouter",
      "together",
      "baseten",
      "deepseek",
      "zai",
      "qwen",
      "chat-template",
      "qwen-chat-template",
      "string-thinking",
      "ant-ling",
    ),
    "Completions thinking encoding.",
  ),
  chatTemplateKwargs: field(
    map(chatTemplateValue),
    "Chat-template keyword parameters and thinking variables.",
  ),
  chatTemplateArgs: field(
    map(chatTemplateValue),
    "Chat-template argument parameters and thinking variables.",
  ),
  cacheControlFormat: field(
    choice("anthropic"),
    "Completions cache-control encoding.",
  ),
  openRouterRouting: field(routing, "OpenRouter routing preferences."),
  vercelGatewayRouting: field(
    object(
      fields(["only", "order"], list(text), "Vercel provider routing list"),
    ),
    "Vercel gateway routing preferences.",
  ),
  sessionAffinityFormat: field(
    choice("openai", "openai-nosession", "openrouter"),
    "Session-affinity header format.",
  ),
  vllmPriority: field(number, "vLLM request priority."),
  allowedFallbackModels: field(
    list(
      object({
        provider: field(named, "Fallback provider ID.", true),
        model: field(named, "Fallback model ID.", true),
        cost: field(cost(false), "Fallback model cost.", true),
      }),
      3,
    ),
    "Anthropic fallback models (at most three).",
  ),
});
const metadata = (override: boolean): Record<string, FieldSchema> => ({
  name: field(named, "Display name."),
  reasoning: field(boolean, "Whether the model supports reasoning."),
  thinkingLevelMap: field(
    thinkingLevelMap,
    "Map host thinking levels to provider efforts.",
  ),
  input: field(list(choice("text", "image")), "Accepted input modalities."),
  inputLimits: field(inputLimits, "Request and image limits."),
  cost: field(
    cost(override),
    override
      ? "Partial cost-rate overrides; tiers remain complete."
      : "Complete cost rates, with optional tiers.",
  ),
  promptCache: field(
    promptCache,
    "Positive short/long prompt cache retention.",
  ),
  contextWindow: field(number, "Context window token count."),
  maxTokens: field(number, "Output token count."),
  samplingParams: field(
    map({ kind: "json" }),
    "Arbitrary JSON sampling parameters.",
  ),
  headers: field(
    map(text),
    "Literal request headers or credential references; values are masked.",
  ),
  compat: field(MODEL_COMPAT_SCHEMA, "Provider API compatibility options."),
});
export const MODEL_SCHEMA: ValueSchema = object({
  id: field(named, "Model identifier.", true),
  api: field(named, "API identifier; custom API strings are accepted."),
  baseUrl: field(named, "Model endpoint; no endpoint probe is performed."),
  ...metadata(false),
});
export const MODEL_OVERRIDE_SCHEMA: ValueSchema = object(metadata(true));
export const PROVIDER_SCHEMA: ValueSchema = object({
  name: field(named, "Provider display name."),
  baseUrl: field(named, "Provider endpoint."),
  apiKey: field(
    named,
    "Literal API key, environment name or !command reference; never resolved.",
    false,
    true,
  ),
  api: field(named, "API identifier; custom strings are accepted."),
  oauth: field(
    choice("radius"),
    "Radius OAuth provider reference; auth.json is excluded.",
  ),
  headers: field(map(text), "Provider request headers; all values are masked."),
  compat: field(
    MODEL_COMPAT_SCHEMA,
    "Provider-wide API compatibility options.",
  ),
  authHeader: field(
    boolean,
    "Send API credentials in the authentication header.",
  ),
  models: field(list(MODEL_SCHEMA), "Complete custom model definitions."),
  modelOverrides: field(
    map(MODEL_OVERRIDE_SCHEMA),
    "Metadata overrides indexed by model ID.",
  ),
});
export const MODELS_SCHEMA: ValueSchema = object({
  providers: field(
    map(PROVIDER_SCHEMA),
    "Providers indexed by provider ID.",
    true,
  ),
});
export const MODELS_DESCRIPTORS: readonly SettingDescriptor[] = [
  {
    id: "pi.models.providers",
    providerId: "pi.models",
    pageId: "models",
    path: ["providers"],
    label: "Providers and models",
    description:
      "Pi 0.99.1 provider definitions, models and metadata overrides. User scope only; saving requires reload and does not select a session model.",
    sourceLabel: "Pi models.json",
    schema: map(PROVIDER_SCHEMA),
    scopes: ["user"],
    sensitivity: "public",
    activation: "reload",
  },
];
