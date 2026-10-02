import type { JsonValue } from "./contracts.ts";
import type {
  EditorSuggestion,
  EditorSuggestionContext,
  EditorSuggestions,
} from "./editors.ts";

/** Only synchronous public metadata snapshots; no authentication or refresh API. */
export interface LocalModelSource {
  getAll(): readonly {
    provider: string;
    id: string;
    name?: string;
    api?: string;
  }[];
  getRegisteredProviderIds?(): readonly string[];
}
interface KnownModel {
  provider: string;
  id: string;
  name: string;
  api?: string;
}
function record(
  value: JsonValue | null | undefined,
): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}
/** Match the catalog's conservative metadata policy; unsafe IDs remain manually editable. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\p{Cc}\p{Cf}]|(?:[a-z][a-z\d+.-]*:\/\/)|[A-Za-z\d_=-]{48,}/iu.test(value)
    ? value
    : undefined;
}
function model(
  provider: string,
  value: { id?: unknown; name?: unknown; api?: unknown },
): KnownModel | undefined {
  const id = identifier(value.id);
  const api = identifier(value.api);
  return id
    ? {
        provider,
        id,
        name: identifier(value.name) ?? id,
        ...(api ? { api } : {}),
      }
    : undefined;
}

/** Presentation-only metadata. Never retains keys, headers, endpoints, or raw configuration. */
export class ModelChoices {
  private readonly baselineProviders = new Set<string>();
  private readonly baseline = new Map<string, KnownModel>();
  private readonly configuredProviders = new Set<string>();
  private configured = new Map<string, KnownModel>();
  private configuredApis = new Set<string>();

  constructor(source?: LocalModelSource) {
    try {
      for (const item of source?.getAll() ?? []) {
        const provider = identifier(item.provider);
        if (!provider) continue;
        this.baselineProviders.add(provider);
        const entry = model(provider, item);
        if (entry)
          this.baseline.set(JSON.stringify([provider, entry.id]), entry);
      }
    } catch {
      /* Missing/failed host metadata leaves custom editing available. */
    }
    try {
      for (const raw of source?.getRegisteredProviderIds?.() ?? []) {
        const provider = identifier(raw);
        if (provider) this.baselineProviders.add(provider);
      }
    } catch {
      /* Catalog failure does not affect storage editing. */
    }
  }

  setConfigured(value: JsonValue | undefined): void {
    this.configuredProviders.clear();
    this.configured = new Map();
    this.configuredApis = new Set();
    const providers = record(record(value)?.providers);
    for (const [rawProvider, definition] of Object.entries(providers ?? {})) {
      const provider = identifier(rawProvider);
      const entry = record(definition);
      if (!provider || !entry) continue;
      this.configuredProviders.add(provider);
      const api = identifier(entry.api);
      if (api) this.configuredApis.add(api);
      if (Array.isArray(entry.models))
        for (const item of entry.models) {
          const fields = record(item);
          const known = fields && model(provider, fields);
          if (known)
            this.configured.set(JSON.stringify([provider, known.id]), known);
        }
    }
  }

  private models(): KnownModel[] {
    return [...new Map([...this.baseline, ...this.configured]).values()].sort(
      (a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
    );
  }
  private providers(): EditorSuggestion[] {
    return [
      ...new Set([...this.baselineProviders, ...this.configuredProviders]),
    ]
      .sort()
      .map((value) => ({
        value,
        label: value,
        description: "Locally known provider; no credential check performed.",
      }));
  }
  private modelValues(
    provider?: string,
    qualified = false,
  ): EditorSuggestion[] {
    return this.models()
      .filter((entry) => !provider || entry.provider === provider)
      .map((entry) => ({
        value: qualified ? `${entry.provider}/${entry.id}` : entry.id,
        label: `${entry.name} · ${entry.provider}`,
        description: `${entry.provider}/${entry.id}`,
      }));
  }
  private apiValues(): EditorSuggestion[] {
    return [
      ...new Set([
        ...this.models().flatMap((entry) => (entry.api ? [entry.api] : [])),
        ...this.configuredApis,
      ]),
    ]
      .sort()
      .map((value) => ({
        value,
        label: value,
        description:
          "Locally known API type; custom API strings remain supported.",
      }));
  }

  native(path: readonly string[], provider?: string): EditorSuggestions {
    return (context) => {
      if (path[0] === "defaultProvider" && context.path.length === 0)
        return this.providers();
      if (path[0] === "defaultModel" && context.path.length === 0)
        return this.modelValues(provider);
      if (
        path[0] === "enabledModels" &&
        context.path.length === 1 &&
        /^\d+$/.test(context.path[0] ?? "")
      )
        return this.modelValues(undefined, true);
      if (
        path[0] === "modelThinkingLevels" &&
        context.path.length === 1 &&
        context.path[0] === "key"
      )
        return this.modelValues(undefined, true);
      return undefined;
    };
  }

  provider(name?: string, creating = false): EditorSuggestions {
    return (context: EditorSuggestionContext) => {
      const path = [...context.path];
      const provider = name ?? identifier(record(context.rootValue)?.name);
      if (creating && path.length === 1 && path[0] === "name")
        return this.providers();
      if (creating && path[0] === "definition") path.shift();
      if (path[path.length - 1] === "api") return this.apiValues();
      if (
        path.length === 3 &&
        path[0] === "models" &&
        /^\d+$/.test(path[1] ?? "") &&
        path[2] === "id"
      )
        return this.modelValues(provider);
      if (
        path.length === 2 &&
        path[0] === "modelOverrides" &&
        path[1] === "key"
      )
        return this.modelValues(provider);
      if (path.includes("allowedFallbackModels")) {
        if (path[path.length - 1] === "provider") return this.providers();
        if (path[path.length - 1] === "model")
          return this.modelValues(
            identifier(record(context.parentValue)?.provider),
          );
      }
      return undefined;
    };
  }
}
