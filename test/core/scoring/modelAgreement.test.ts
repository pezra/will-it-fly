import { describe, expect, it } from "vitest";
import { SCORING_DEFAULTS } from "../../../src/core/scoring/defaults";
import {
  checkAgrees,
  checkCovers,
  confidenceForShare,
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
    conditions: [],
  };
}

const ECMWF = result("good", 10, 270);

describe("checkCovers", () => {
  it("is false for a missing result and for noData", () => {
    expect(checkCovers(undefined)).toBe(false);
    expect(checkCovers(result("noData"))).toBe(false);
  });

  it("is true for good, flyable and noGo results", () => {
    expect(checkCovers(result("good", 10))).toBe(true);
    expect(checkCovers(result("flyable", 10))).toBe(true);
    expect(checkCovers(result("noGo", 10))).toBe(true);
  });
});

describe("checkAgrees", () => {
  it("agrees for similar wind", () => {
    expect(checkAgrees(ECMWF, result("good", 11, 280))).toBe(true);
  });

  it("agrees when RRFS is flyable", () => {
    expect(checkAgrees(ECMWF, result("flyable", 11, 280))).toBe(true);
  });

  it("direction: 30 degrees agrees, 31 does not", () => {
    expect(checkAgrees(ECMWF, result("good", 10, 300))).toBe(true);
    expect(checkAgrees(ECMWF, result("good", 10, 301))).toBe(false);
  });

  it("direction wraps through north: 350 vs 10 is 20 degrees", () => {
    const e = result("good", 10, 350);
    expect(checkAgrees(e, result("good", 10, 10))).toBe(true);
    expect(checkAgrees(e, result("good", 10, 21))).toBe(false);
  });

  it("direction matters at light wind", () => {
    expect(checkAgrees(result("good", 3, 270), result("good", 3, 0))).toBe(false);
    expect(checkAgrees(result("good", 3.9, 0), result("good", 3.9, 180))).toBe(false);
    expect(checkAgrees(result("good", 0.1, 0), result("good", 0.1, 20))).toBe(true);
  });

  it("a 0 mph wind on either side waives direction", () => {
    expect(checkAgrees(result("good", 0, 90), result("good", 3, 270))).toBe(true);
    expect(checkAgrees(result("good", 3, 270), result("good", 0, 90))).toBe(true);
    expect(checkAgrees(result("good", 0, 90), result("good", 0, 270))).toBe(true);
  });

  it("a 0 mph wind waives direction but not the speed check", () => {
    expect(checkAgrees(result("good", 0, 90), result("good", 6, 270))).toBe(false);
  });

  it("speed: 5 mph apart agrees, 5.1 apart does not", () => {
    expect(checkAgrees(ECMWF, result("good", 15, 270))).toBe(true);
    expect(checkAgrees(ECMWF, result("good", 5, 270))).toBe(true);
    expect(checkAgrees(ECMWF, result("good", 15.1, 270))).toBe(false);
    expect(checkAgrees(ECMWF, result("good", 4.9, 270))).toBe(false);
  });

  it("disagrees when RRFS is noGo, even with matching wind", () => {
    expect(checkAgrees(ECMWF, result("noGo", 10, 270))).toBe(false);
  });

  it("disagrees when RRFS is missing or noData", () => {
    expect(checkAgrees(ECMWF, undefined)).toBe(false);
    expect(checkAgrees(ECMWF, result("noData"))).toBe(false);
  });

  it("disagrees when either launch wind is missing", () => {
    expect(checkAgrees(ECMWF, result("good"))).toBe(false);
    expect(checkAgrees(result("good"), result("good", 10, 270))).toBe(false);
  });

  it("uses the supplied defaults", () => {
    const loose = { ...SCORING_DEFAULTS, agreementMaxDirDiffDeg: 90 };
    expect(checkAgrees(ECMWF, result("good", 10, 350), loose)).toBe(true);
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
