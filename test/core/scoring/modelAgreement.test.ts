import { describe, expect, it } from "vitest";
import { SCORING_DEFAULTS } from "../../../src/core/scoring/defaults";
import {
  confidenceForShare,
  rrfsAgrees,
  rrfsCovers,
} from "../../../src/core/scoring/modelAgreement";
import type { HourCall, HourResult } from "../../../src/core/scoring/hourEvaluator";

function result(call: HourCall, speedMph?: number, dirDeg?: number): HourResult {
  return {
    time: 0,
    call,
    score: 50,
    reasons: [],
    launchWind: speedMph === undefined ? undefined : { speedMph, dirDeg: dirDeg ?? 270 },
    unpenalizedScore: 50,
  };
}

const ECMWF = result("flyable", 10, 270);

describe("rrfsCovers", () => {
  it("is false for a missing result and for noData", () => {
    expect(rrfsCovers(undefined)).toBe(false);
    expect(rrfsCovers(result("noData"))).toBe(false);
  });

  it("is true for flyable, marginal and noGo results", () => {
    expect(rrfsCovers(result("flyable", 10))).toBe(true);
    expect(rrfsCovers(result("marginal", 10))).toBe(true);
    expect(rrfsCovers(result("noGo", 10))).toBe(true);
  });
});

describe("rrfsAgrees", () => {
  it("agrees for similar wind", () => {
    expect(rrfsAgrees(ECMWF, result("flyable", 11, 280))).toBe(true);
  });

  it("agrees when RRFS is marginal", () => {
    expect(rrfsAgrees(ECMWF, result("marginal", 11, 280))).toBe(true);
  });

  it("direction: 30 degrees agrees, 31 does not", () => {
    expect(rrfsAgrees(ECMWF, result("flyable", 10, 300))).toBe(true);
    expect(rrfsAgrees(ECMWF, result("flyable", 10, 301))).toBe(false);
  });

  it("direction wraps through north: 350 vs 10 is 20 degrees", () => {
    const e = result("flyable", 10, 350);
    expect(rrfsAgrees(e, result("flyable", 10, 10))).toBe(true);
    expect(rrfsAgrees(e, result("flyable", 10, 21))).toBe(false);
  });

  it("both winds under 4 mph agree regardless of direction", () => {
    expect(rrfsAgrees(result("flyable", 3.9, 0), result("flyable", 3.9, 180))).toBe(true);
  });

  it("4 mph is not calm, so direction still matters", () => {
    expect(rrfsAgrees(result("flyable", 4, 0), result("flyable", 4, 180))).toBe(false);
  });

  it("one calm wind and one not is judged on direction", () => {
    expect(rrfsAgrees(result("flyable", 3, 0), result("flyable", 6, 180))).toBe(false);
  });

  it("calm waives direction but not the speed check", () => {
    // Under the calm threshold the speeds can never differ by more than 5, so this holds
    // with the default numbers; with a tighter speed limit the speed check still bites.
    const tight = { ...SCORING_DEFAULTS, agreementMaxSpeedDiffMph: 0.5 };
    expect(rrfsAgrees(result("flyable", 1, 0), result("flyable", 3, 180), tight)).toBe(false);
  });

  it("speed: 5 mph apart agrees, 5.1 apart does not", () => {
    expect(rrfsAgrees(ECMWF, result("flyable", 15, 270))).toBe(true);
    expect(rrfsAgrees(ECMWF, result("flyable", 5, 270))).toBe(true);
    expect(rrfsAgrees(ECMWF, result("flyable", 15.1, 270))).toBe(false);
    expect(rrfsAgrees(ECMWF, result("flyable", 4.9, 270))).toBe(false);
  });

  it("disagrees when RRFS is noGo, even with matching wind", () => {
    expect(rrfsAgrees(ECMWF, result("noGo", 10, 270))).toBe(false);
  });

  it("disagrees when RRFS is missing or noData", () => {
    expect(rrfsAgrees(ECMWF, undefined)).toBe(false);
    expect(rrfsAgrees(ECMWF, result("noData"))).toBe(false);
  });

  it("disagrees when either launch wind is missing", () => {
    expect(rrfsAgrees(ECMWF, result("flyable"))).toBe(false);
    expect(rrfsAgrees(result("flyable"), result("flyable", 10, 270))).toBe(false);
  });

  it("uses the supplied defaults", () => {
    const loose = { ...SCORING_DEFAULTS, agreementMaxDirDiffDeg: 90 };
    expect(rrfsAgrees(ECMWF, result("flyable", 10, 350), loose)).toBe(true);
  });
});

describe("confidenceForShare", () => {
  it("75% is high, just under is medium", () => {
    expect(confidenceForShare(0.75)).toBe("high");
    expect(confidenceForShare(0.74)).toBe("medium");
  });

  it("40% is medium, just under is low", () => {
    expect(confidenceForShare(0.4)).toBe("medium");
    expect(confidenceForShare(0.39)).toBe("low");
  });

  it("extremes", () => {
    expect(confidenceForShare(1)).toBe("high");
    expect(confidenceForShare(0)).toBe("low");
  });
});
