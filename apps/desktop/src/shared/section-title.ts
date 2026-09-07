/** One rule for every section title, regardless of who supplied it. */
export const SECTION_TITLE_CAP = 80;

export function compactSectionTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > SECTION_TITLE_CAP
    ? `${normalized.slice(0, SECTION_TITLE_CAP - 1)}…`
    : normalized;
}
