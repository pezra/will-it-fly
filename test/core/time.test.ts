import { describe, expect, it } from "vitest";
import { denverDayKey, denverHour, formatDenverTime } from "../../src/core/time";

const at = (iso: string) => Date.parse(iso);

describe("time (America/Denver)", () => {
  it("handles a summer (MDT) instant", () => {
    const t = at("2026-07-15T18:00:00Z"); // 12:00 MDT
    expect(denverDayKey(t)).toBe("2026-07-15");
    expect(denverHour(t)).toBe(12);
  });

  it("handles a winter (MST) instant", () => {
    const t = at("2026-01-15T18:00:00Z"); // 11:00 MST
    expect(denverDayKey(t)).toBe("2026-01-15");
    expect(denverHour(t)).toBe(11);
  });

  it("handles the 2026-11-01 fall-back", () => {
    expect(denverHour(at("2026-11-01T07:30:00Z"))).toBe(1); // 01:30 MDT
    expect(denverHour(at("2026-11-01T08:30:00Z"))).toBe(1); // 01:30 MST
    expect(denverHour(at("2026-11-01T09:30:00Z"))).toBe(2); // 02:30 MST
    expect(denverDayKey(at("2026-11-01T08:30:00Z"))).toBe("2026-11-01");
  });

  it("gives the previous day's key just before local midnight", () => {
    const t = at("2026-07-16T05:59:00Z"); // 23:59 MDT on the 15th
    expect(denverDayKey(t)).toBe("2026-07-15");
    expect(denverHour(t)).toBe(23);
  });

  it("rolls the day key over at local midnight", () => {
    const t = at("2026-07-16T06:00:00Z"); // 00:00 MDT on the 16th
    expect(denverDayKey(t)).toBe("2026-07-16");
    expect(denverHour(t)).toBe(0);
  });

  it("formats hours as HH:00", () => {
    expect(formatDenverTime(at("2026-07-15T18:45:00Z"))).toBe("12:00");
    expect(formatDenverTime(at("2026-07-16T06:10:00Z"))).toBe("00:00");
    expect(formatDenverTime(at("2026-07-15T15:00:00Z"))).toBe("09:00");
  });
});
