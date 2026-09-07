import { describe, expect, it } from "vitest";
import { SECTION_TITLE_CAP, compactSectionTitle } from "./section-title";

describe("section titles", () => {
  it("normalizes whitespace and keeps titles at or below 80 characters", () => {
    expect(compactSectionTitle("  Improve\n Codex   titles ")).toBe("Improve Codex titles");
    expect(compactSectionTitle("x".repeat(SECTION_TITLE_CAP))).toHaveLength(80);
    expect(compactSectionTitle("x".repeat(SECTION_TITLE_CAP + 20))).toBe(`${"x".repeat(79)}…`);
  });
});
