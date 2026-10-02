import type { SettingDescriptor } from "./contracts.ts";

export interface SearchMatch {
  descriptor: SettingDescriptor;
  sourceLabel: string;
}

/** The index accepts descriptors only: reads, configured values, and revisions never enter it. */
export class MetadataSearchIndex {
  private entries: { descriptor: SettingDescriptor; text: string }[] = [];

  constructor(descriptors: readonly SettingDescriptor[]) {
    this.replace(descriptors);
  }

  replace(descriptors: readonly SettingDescriptor[]): void {
    this.entries = descriptors
      .filter((descriptor) => descriptor.metadataSensitivity !== "masked")
      .map((descriptor) => ({
        descriptor,
        text: [
          descriptor.id,
          descriptor.providerId,
          descriptor.pageId,
          descriptor.path.join("."),
          descriptor.label,
          descriptor.description,
          descriptor.sourceLabel,
          ...(descriptor.searchTerms ?? []),
        ]
          .join(" ")
          .toLowerCase(),
      }));
  }

  search(query: string): SearchMatch[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.entries
      .filter((entry) => terms.every((term) => entry.text.includes(term)))
      .map(({ descriptor }) => ({
        descriptor,
        sourceLabel: descriptor.sourceLabel,
      }));
  }
}
