import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import hostedGitInfo from "hosted-git-info";
import type { JsonValue } from "./contracts.ts";

export interface ResourceBases {
  user: string;
  project: string;
}
function localPath(source: string, base: string): string {
  let path = source.trim();
  if (
    process.platform === "win32" &&
    !path.includes("\\") &&
    !path.startsWith("//")
  ) {
    const drive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive)
      path = `${drive[1]?.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (path === "~") path = homedir();
  else if (
    path.startsWith("~/") ||
    (process.platform === "win32" && path.startsWith("~\\"))
  )
    path = join(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return resolve(base, path);
}

function gitIdentity(source: string): string | undefined {
  const trimmed = source.trim();
  const prefixed = trimmed.startsWith("git:");
  const raw = prefixed ? trimmed.slice(4).trim() : trimmed;
  if (!prefixed && !/^(https?|ssh|git):\/\//i.test(raw)) return undefined;
  let repo = raw;
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  if (scp) repo = `git@${scp[1]}:${(scp[2] ?? "").split("@")[0]}`;
  else if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      url.pathname = url.pathname.split("@")[0] ?? url.pathname;
      repo = url.toString();
    } catch {
      return undefined;
    }
  } else {
    const slash = raw.indexOf("/");
    if (slash >= 0)
      repo = `${raw.slice(0, slash)}/${raw.slice(slash + 1).split("@")[0]}`;
  }
  const info =
    hostedGitInfo.fromUrl(repo) ?? hostedGitInfo.fromUrl(`https://${repo}`);
  if (info)
    return `git:${info.domain}/${info.user}/${info.project?.replace(/\.git$/, "")}`;
  let host: string;
  let path: string;
  const gitScp = repo.match(/^git@([^:]+):(.+)$/);
  if (gitScp) {
    host = gitScp[1] ?? "";
    path = gitScp[2] ?? "";
  } else if (/^(https?|ssh|git):\/\//.test(repo)) {
    const url = new URL(repo);
    host = url.hostname;
    path = url.pathname.replace(/^\/+/, "");
  } else {
    const slash = repo.indexOf("/");
    if (slash < 0) return undefined;
    host = repo.slice(0, slash);
    path = repo.slice(slash + 1);
    if (!host.includes(".") && host !== "localhost") return undefined;
  }
  path = path.replace(/\.git$/, "");
  try {
    for (const part of [host, path]) {
      const decoded = decodeURIComponent(part);
      if (
        [part, decoded].some(
          (value) =>
            value.includes("\0") ||
            value.includes("\\") ||
            value.startsWith("/") ||
            value.split("/").includes(".."),
        )
      )
        return undefined;
    }
  } catch {
    return undefined;
  }
  return host && path.split("/").length >= 2
    ? `git:${host}/${path}`
    : undefined;
}

export function packageIdentity(source: string, base: string): string {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4).trim();
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
    return `npm:${match?.[1] ?? spec}`;
  }
  return gitIdentity(source) ?? `local:${localPath(source, base)}`;
}

/** Host loader package precedence, without scanning packages or installing/probing sources. */
export function combinedPackages(
  user: JsonValue | undefined,
  project: JsonValue | undefined,
  bases: ResourceBases,
): JsonValue[] {
  const result: { value: JsonValue; scope: "user" | "project" }[] = [];
  const seen = new Map<string, number>();
  for (const scope of ["project", "user"] as const) {
    const entries = scope === "user" ? user : project;
    if (!Array.isArray(entries)) continue;
    for (const value of entries) {
      const source =
        typeof value === "string"
          ? value
          : value !== null &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              typeof value.source === "string"
            ? value.source
            : undefined;
      if (source === undefined) continue;
      const identity = packageIdentity(source, bases[scope]);
      const index = seen.get(identity);
      if (index === undefined) {
        seen.set(identity, result.length);
        result.push({ value, scope });
      } else {
        const previous = result[index];
        if (
          previous?.scope === "project" &&
          scope === "user" &&
          previous.value !== null &&
          typeof previous.value === "object" &&
          !Array.isArray(previous.value) &&
          previous.value.autoload === false
        )
          result.push({ value, scope });
      }
    }
  }
  return result.map((entry) => structuredClone(entry.value));
}
