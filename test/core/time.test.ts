import { describe, expect, it } from "vitest";
import { addDays, denverDayKey, denverHour, formatDayKey, formatDenverTime, isDayKey } from "../../src/core/time";

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

describe("day keys", () => {
  it("adds calendar days across DST changes, months and years", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-11-08", 14)).toBe("2026-11-22");
    expect(addDays("2026-11-08", -8)).toBe("2026-10-31");
  });
  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isDayKey("2026-11-08")).toBe(true);
    expect(isDayKey("2028-02-29")).toBe(true);
    expect(isDayKey("2026-02-29")).toBe(false);
    expect(isDayKey("2026-13-01")).toBe(false);
    expect(isDayKey("2026-1-01")).toBe(false);
    expect(isDayKey("tomorrow")).toBe(false);
    expect(() => addDays("nope", 1)).toThrow();
  });
  it("formats a day key without shifting it", () => {
    expect(formatDayKey("2026-11-10")).toBe("Tue, Nov 10");
    expect(formatDayKey("2027-01-01")).toBe("Fri, Jan 1");
  });
});
