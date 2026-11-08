import { describe, expect, it } from "vitest";
import {
  approxFeet,
  arcLabel,
  callGlyph,
  callLabel,
  confidenceLabel,
  feet,
  forecastAge,
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
});
