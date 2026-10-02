import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piSettings from "@pi-blackmagic/pi-settings";

type Extension = (pi: ExtensionAPI) => void;

export function composeExtensions(
  pi: ExtensionAPI,
  extensions: readonly Extension[] = [piSettings],
): void {
  for (const extension of extensions) {
    extension(pi);
  }
}

export default function blackmagic(pi: ExtensionAPI): void {
  composeExtensions(pi);
}
