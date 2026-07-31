import { describe, expect, it } from "vitest";
import { fromDateInputValue, resolveUsageRange, toDateInputValue } from "./usage";

// 2026-07-29 is a Wednesday.
const NOW = new Date(2026, 6, 29, 14, 30, 0);

const day = (value: Date): string => toDateInputValue(value);

describe("resolveUsageRange", () => {
  it("covers only today for the today preset", () => {
    const range = resolveUsageRange("today", NOW);
    expect(day(range.from)).toBe("2026-07-29");
    expect(day(range.to)).toBe("2026-07-29");
    expect(range.from.getHours()).toBe(0);
    expect(range.to.getHours()).toBe(23);
  });

  it("covers only yesterday for the yesterday preset", () => {
    const range = resolveUsageRange("yesterday", NOW);
    expect(day(range.from)).toBe("2026-07-28");
    expect(day(range.to)).toBe("2026-07-28");
  });

  it("starts this week on Monday", () => {
    const range = resolveUsageRange("this-week", NOW);
    expect(day(range.from)).toBe("2026-07-27");
    expect(day(range.to)).toBe("2026-07-29");
  });

  it("makes last 7 days inclusive of today", () => {
    const range = resolveUsageRange("last-7", NOW);
    expect(day(range.from)).toBe("2026-07-23");
    expect(day(range.to)).toBe("2026-07-29");
  });

  it("runs this month from the first of the month", () => {
    const range = resolveUsageRange("this-month", NOW);
    expect(day(range.from)).toBe("2026-07-01");
    expect(day(range.to)).toBe("2026-07-29");
  });

  it("makes last 30 days inclusive of today", () => {
    const range = resolveUsageRange("last-30", NOW);
    expect(day(range.from)).toBe("2026-06-30");
    expect(day(range.to)).toBe("2026-07-29");
  });

  it("honours a custom range and swaps reversed endpoints", () => {
    const forward = resolveUsageRange("custom", NOW, { from: "2026-05-02", to: "2026-05-09" });
    expect(day(forward.from)).toBe("2026-05-02");
    expect(day(forward.to)).toBe("2026-05-09");

    const reversed = resolveUsageRange("custom", NOW, { from: "2026-05-09", to: "2026-05-02" });
    expect(day(reversed.from)).toBe("2026-05-02");
    expect(day(reversed.to)).toBe("2026-05-09");
  });

  it("falls back to this month when a custom endpoint is unusable", () => {
    const range = resolveUsageRange("custom", NOW, { from: "", to: "2026-05-09" });
    expect(day(range.from)).toBe("2026-07-01");
    expect(day(range.to)).toBe("2026-07-29");
  });
});

describe("date input round-tripping", () => {
  it("parses back to the same local day", () => {
    expect(day(fromDateInputValue("2026-01-05")!)).toBe("2026-01-05");
    expect(fromDateInputValue("nope")).toBeNull();
  });
});
