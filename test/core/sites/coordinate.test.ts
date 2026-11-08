import { describe, expect, it } from "vitest";
import { distanceM, offset } from "../../../src/core/sites/coordinate";

describe("coordinate", () => {
  it("boulderToGoldenIsAbout29km", () => {
    const boulder = { latitude: 40.015, longitude: -105.2705 };
    const golden = { latitude: 39.7555, longitude: -105.2211 };
    const km = distanceM(boulder, golden) / 1000;
    expect(Math.abs(km - 29.2)).toBeLessThan(0.3);
    expect(distanceM(boulder, boulder)).toBe(0);
  });

  it("offsetNorthMovesLatitude", () => {
    const start = { latitude: 39.5, longitude: -107.3 };
    const n = offset(start, 0, 8047);
    expect(Math.abs(n.latitude - start.latitude - 0.0724)).toBeLessThan(0.0005);
    expect(Math.abs(n.longitude - start.longitude)).toBeLessThan(1e-9);
  });

  it("offsetRoundTripsDistance", () => {
    const start = { latitude: 39.5, longitude: -107.3 };
    for (const bearing of [0, 90, 180, 270]) {
      const p = offset(start, bearing, 8047);
      expect(Math.abs(distanceM(start, p) - 8047)).toBeLessThan(1);
    }
    const e = offset(start, 90, 8047);
    expect(e.longitude).toBeGreaterThan(start.longitude);
    const w = offset(start, 270, 8047);
    expect(w.longitude).toBeLessThan(start.longitude);
  });
});
