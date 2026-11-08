import { describe, expect, it } from "vitest";
import { testLaunch } from "../support/builders";
import {
  approxFeet,
  arcLabel,
  callGlyph,
  callLabel,
  confidenceLabel,
  dayLabel,
  feet,
  forecastAge,
  idealLabel,
  miles,
  oneDecimal,
  whole,
} from "../../src/ui/format";

describe("number formats", () => {
  it("rounds cloud base to 100 ft with a leading ≈", () => {
    expect(approxFeet(1000)).toBe("≈ 3,300 ft");
    expect(approxFeet(0)).toBe("≈ 0 ft");
    expect(approxFeet(undefined)).toBe("n/a");
  });
  it("formats feet, miles, cape and TI", () => {
    expect(feet(9200)).toBe("9,200 ft");
    expect(miles(16093.44)).toBe("10 mi");
    expect(miles(8046.72)).toBe("5.0 mi");
    expect(miles(undefined)).toBeUndefined();
    expect(whole(1400.4)).toBe("1,400");
    expect(whole(undefined)).toBe("n/a");
    expect(oneDecimal(-2.14)).toBe("−2.1");
    expect(oneDecimal(3)).toBe("3.0");
    expect(oneDecimal(undefined)).toBe("n/a");
  });
});

describe("forecastAge", () => {
  const now = 10 * 3_600_000;
  it("uses minutes, hours and days", () => {
    expect(forecastAge(now, now)).toBe("Forecast from just now");
    expect(forecastAge(now - 12 * 60_000, now)).toBe("Forecast from 12 min ago");
    expect(forecastAge(now - 3 * 3_600_000, now)).toBe("Forecast from 3 h ago");
    expect(forecastAge(now - 72 * 3_600_000, now)).toBe("Forecast from 3 days ago");
  });
  it("treats a future fetch time as just now", () => {
    expect(forecastAge(now + 60_000, now)).toBe("Forecast from just now");
  });
});

describe("labels", () => {
  it("labels arcs with compass names", () => {
    expect(arcLabel({ from: 270, to: 310 })).toBe("270–310° (W–NW)");
    expect(arcLabel({ from: 330, to: 30 })).toBe("330–30° (NNW–NNE)");
  });
  it("gives every call a label and a glyph", () => {
    for (const call of ["good", "flyable", "noGo", "noData"] as const) {
      expect(callLabel(call).length).toBeGreaterThan(0);
      expect(callGlyph(call).length).toBeGreaterThan(0);
    }
    expect(callLabel("noGo")).toBe("No-go");
  });
  it("labels confidence", () => {
    expect(confidenceLabel("ecmwfOnly")).toBe("ECMWF only");
    expect(confidenceLabel("high")).toBe("high confidence");
  });
  it("labels days relative to today", () => {
    expect(dayLabel("2026-11-08", "2026-11-08")).toBe("Today");
    expect(dayLabel("2026-11-09", "2026-11-08")).toBe("Tomorrow");
    expect(dayLabel("2026-11-10", "2026-11-08")).toBe("Tue, Nov 10");
    expect(dayLabel("2027-01-01", "2026-12-31")).toBe("Tomorrow");
  });
});

describe("idealLabel", () => {
  const withIdeal = (ideal: { from: number; to: number }[]) =>
    idealLabel(testLaunch({ directions: { ok: [{ from: 180, to: 270 }], ideal } }));

  it("says anywhere in the OK range when there are no ideal arcs", () => {
    expect(withIdeal([])).toBe("anywhere in the OK range");
  });
  it("shows a zero-width ideal as the heading plus or minus 15 degrees", () => {
    expect(withIdeal([{ from: 200, to: 200 }])).toBe("185–215° (S–SW)");
  });
  it("wraps a widened arc below 0", () => {
    expect(withIdeal([{ from: 5, to: 5 }])).toMatch(/^350–20°/);
  });
  it("shows a normal arc as is", () => {
    expect(withIdeal([{ from: 250, to: 290 }])).toMatch(/^250–290°/);
  });
});
