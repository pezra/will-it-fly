import { describe, expect, it } from "vitest";
import { angularDifference } from "../../../src/core/sites/degreeArc";
import {
  aloftWind,
  cloudBaseAboveLaunchM,
  launchWind,
  thermalIndex,
  topOfLiftM,
  windFromComponents,
  windU,
  windV,
} from "../../../src/core/scoring/derived";
import {
  cloudBaseBonusM,
  lowCloudBaseMarginalM,
  runLengthWeight,
  SCORING_DEFAULTS,
} from "../../../src/core/scoring/defaults";
import { PERFECT_LAUNCH_ELEVATION_M, isClose, perfectHour } from "../../support/hourBuilder";

describe("Wind", () => {
  it("fromNorthPointsSouth", () => {
    // Wind from 0: u = -10*sin0 = 0, v = -10*cos0 = -10.
    const w = { speedMph: 10, dirDeg: 0 };
    expect(isClose(windU(w), 0)).toBe(true);
    expect(isClose(windV(w), -10)).toBe(true);
  });

  it("fromEastPointsWest", () => {
    // Wind from 90: u = -10*sin90 = -10, v = -10*cos90 = 0.
    const w = { speedMph: 10, dirDeg: 90 };
    expect(isClose(windU(w), -10)).toBe(true);
    expect(isClose(windV(w), 0)).toBe(true);
  });

  it("fromComponents", () => {
    // u = -10, v = 0 -> s = 10, theta = atan2(10, 0) = 90.
    const w = windFromComponents(-10, 0);
    expect(isClose(w.speedMph, 10)).toBe(true);
    expect(isClose(w.dirDeg, 90)).toBe(true);
    // u = 10, v = 0 -> theta = atan2(-10, 0) = -90 -> 270.
    const west = windFromComponents(10, 0);
    expect(isClose(west.dirDeg, 270)).toBe(true);
  });

  it("roundTripsAcrossCompass", () => {
    for (let dir = 0; dir < 360; dir += 15) {
      const w = { speedMph: 12.5, dirDeg: dir };
      const back = windFromComponents(windU(w), windV(w));
      expect(isClose(back.speedMph, 12.5)).toBe(true);
      expect(angularDifference(back.dirDeg, dir)).toBeLessThan(1e-9);
      expect(back.dirDeg >= 0 && back.dirDeg < 360).toBe(true);
    }
  });

  it("calmHasZeroDirection", () => {
    const w = windFromComponents(0, 0);
    expect(w.speedMph).toBe(0);
    expect(w.dirDeg).toBe(0);
    // toBe uses Object.is, so this also rejects -0.
    expect(windFromComponents(-0, -0).dirDeg).toBe(0);
  });
});

describe("launchWind", () => {
  /** Z700 = 3000 m, Z600 = 4000 m, Z500 = 5500 m; 10 m wind 10 mph from 270. */
  function bracketed(w700 = 12, d700 = 270, w600 = 16, d600 = 270) {
    return perfectHour()
      .level(700, (l) => {
        l.heightM = 3000;
        l.windMph = w700;
        l.windDir = d700;
      })
      .level(600, (l) => {
        l.heightM = 4000;
        l.windMph = w600;
        l.windDir = d600;
      })
      .level(500, (l) => {
        l.heightM = 5500;
      });
  }

  it("interpolatedWinsWhenStronger", () => {
    // Launch 3500 m is halfway from Z700 to Z600: (12 + 16)/2 = 14 mph from 270, > 10 m's 8.
    const hour = bracketed()
      .with((h) => {
        h.windMph = 8;
        h.windDir = 200;
      })
      .build();
    const w = launchWind(hour, 3500);
    expect(isClose(w?.speedMph, 14)).toBe(true);
    expect(isClose(w?.dirDeg, 270)).toBe(true);
  });

  it("tenMeterWinsWhenStronger", () => {
    // Interpolated is 14 mph; 10 m is 20 mph from 250 -> 10 m, with its own direction.
    const hour = bracketed()
      .with((h) => {
        h.windMph = 20;
        h.windDir = 250;
      })
      .build();
    expect(launchWind(hour, 3500)).toEqual({ speedMph: 20, dirDeg: 250 });
  });

  it("tieGoesToTenMeter", () => {
    const hour = bracketed()
      .with((h) => {
        h.windMph = 14;
        h.windDir = 250;
      })
      .build();
    expect(launchWind(hour, 3500)).toEqual({ speedMph: 14, dirDeg: 250 });
  });

  it("fractionalInterpolation", () => {
    // Perfect hour: Z700 3100 (12 mph), Z600 4400 (15 mph -> set dir 270 too).
    // Launch 3300: t = 200/1300 = 0.153846; speed = 12 + 3 * 0.153846 = 12.4615 mph.
    const hour = perfectHour()
      .level(600, (l) => {
        l.windDir = 270;
      })
      .build();
    const w = launchWind(hour, 3300);
    expect(isClose(w?.speedMph, 12 + (3 * 200) / 1300)).toBe(true);
    expect(isClose(w?.dirDeg, 270)).toBe(true);
  });

  it("belowZ700UsesTenMeterOnly", () => {
    // Launch 2000 m < Z700 3100 m: even a 30 mph 700 hPa wind is ignored.
    const hour = perfectHour()
      .level(700, (l) => {
        l.windMph = 30;
      })
      .build();
    expect(launchWind(hour, 2000)).toEqual({ speedMph: 10, dirDeg: 270 });
  });

  it("interpolatesAcrossNorth", () => {
    // 12 mph from 350 at Z700 and from 10 at Z600, launch halfway.
    // u700 = -12*sin350 = +2.0838, u600 = -12*sin10 = -2.0838 -> mean u = 0.
    // v700 = v600 = -12*cos10 = -11.8177 -> mean v = -11.8177.
    // -> speed 12*cos10 = 11.8177 mph, from atan2(0, 11.8177) = 0. Not 180.
    const hour = bracketed(12, 350, 12, 10)
      .with((h) => {
        h.windMph = 5;
      })
      .build();
    const w = launchWind(hour, 3500);
    expect(isClose(w?.speedMph, 12 * Math.cos((10 * Math.PI) / 180))).toBe(true);
    expect(angularDifference(w?.dirDeg ?? 180, 0)).toBeLessThan(0.01);
  });

  it("speedAtLevelBoundary", () => {
    // Launch exactly at Z600 (4000 m) -> 600 hPa's 16 mph.
    const at600 = launchWind(bracketed().build(), 4000);
    expect(isClose(at600?.speedMph, 16)).toBe(true);
    // Launch exactly at Z700 (3000 m) -> 700 hPa's 12 mph (inclusive at Z700).
    const at700 = launchWind(bracketed().build(), 3000);
    expect(isClose(at700?.speedMph, 12)).toBe(true);
    // Just below Z700 -> 10 m only.
    const below = launchWind(bracketed().build(), 2999.9);
    expect(below).toEqual({ speedMph: 10, dirDeg: 270 });
  });

  it("upperBracketUsesSixHundredAndFiveHundred", () => {
    // Launch 4750 m between Z600 4000 (16 mph) and Z500 5500 (perfect: 20 mph from 280).
    // Use 500 dir 270: t = 750/1500 = 0.5 -> 18 mph.
    const hour = bracketed()
      .level(500, (l) => {
        l.windDir = 270;
      })
      .build();
    const w = launchWind(hour, 4750);
    expect(isClose(w?.speedMph, 18)).toBe(true);
  });

  it("nilTenMeterIsNilEvenWithLevels", () => {
    const noSpeed = bracketed()
      .with((h) => {
        h.windMph = undefined;
      })
      .build();
    expect(launchWind(noSpeed, 3500)).toBeUndefined();
    const noDir = bracketed()
      .with((h) => {
        h.windDir = undefined;
      })
      .build();
    expect(launchWind(noDir, 3500)).toBeUndefined();
  });

  it("incompleteBracketFallsBackToTenMeter", () => {
    // 600 hPa wind missing: don't jump to the 700/500 pair; use 10 m.
    const hour = bracketed(30)
      .level(600, (l) => {
        l.windMph = undefined;
      })
      .build();
    expect(launchWind(hour, 3500)).toEqual({ speedMph: 10, dirDeg: 270 });
    // Missing Z700 entirely: can't tell whether the launch is above Z700 -> 10 m.
    const noZ700 = bracketed(30)
      .level(700, (l) => {
        l.heightM = undefined;
      })
      .build();
    expect(launchWind(noZ700, 3500)).toEqual({ speedMph: 10, dirDeg: 270 });
  });

  it("aboveAllLevelsUsesTenMeter", () => {
    expect(launchWind(bracketed().build(), 6000)).toEqual({ speedMph: 10, dirDeg: 270 });
  });
});

describe("aloftWind", () => {
  it("strongestLevelInBand", () => {
    // Launch 2000, top of lift 6000: band 2600-6000 holds 700 (12), 600 (15), 500 (20 @ 280).
    const w = aloftWind(perfectHour().build(), 2000, 6000);
    expect(w).toEqual({ speedMph: 20, dirDeg: 280 });
  });

  it("levelAboveTopOfLiftIsExcluded", () => {
    // Perfect hour: top of lift 4000 -> band 2600-4000 has only 700 (12 mph from 270),
    // even though 600 hPa (4400 m, 15 mph) is stronger.
    const w = aloftWind(perfectHour().build(), 2000, 4000);
    expect(w).toEqual({ speedMph: 12, dirDeg: 270 });
  });

  it("bandIsInclusive", () => {
    // Z700 exactly at launch + 600 and Z600 exactly at top of lift are both in the band.
    const hour = perfectHour()
      .level(700, (l) => {
        l.heightM = 2600;
      })
      .level(600, (l) => {
        l.heightM = 4000;
      })
      .build();
    expect(aloftWind(hour, 2000, 4000)).toEqual({ speedMph: 15, dirDeg: 275 });
  });

  it("emptyBandFallsBackToLowestQualifyingLevel", () => {
    // Top of lift 2500 is below launch + 600 = 2600 -> lowest level >= 2600 is 700 hPa.
    const low = aloftWind(perfectHour().build(), 2000, 2500);
    expect(low).toEqual({ speedMph: 12, dirDeg: 270 });
    // Peak launch 3444 m above Z700 3100: needs >= 4044; top of lift 4000 -> empty band,
    // lowest qualifying is 600 hPa (4400 m, 15 mph from 275).
    const peak = aloftWind(perfectHour().build(), 3444, 4000);
    expect(peak).toEqual({ speedMph: 15, dirDeg: 275 });
  });

  it("noQualifyingLevelIsNil", () => {
    // Launch 5500 needs >= 6100 m; Z500 is 5800.
    expect(aloftWind(perfectHour().build(), 5500, 7000)).toBeUndefined();
  });

  it("incompleteLevelsAreSkipped", () => {
    // 700 hPa missing its direction: band (2600-6000) max is 500 hPa; with 500 also missing
    // its speed, it's 600 hPa.
    const hour = perfectHour()
      .level(700, (l) => {
        l.windDir = undefined;
        l.windMph = 50;
      })
      .level(500, (l) => {
        l.windMph = undefined;
      })
      .build();
    expect(aloftWind(hour, 2000, 6000)).toEqual({ speedMph: 15, dirDeg: 275 });
  });

  it("offsetComesFromDefaults", () => {
    // With a 1500 m offset, launch 2000 needs >= 3500: 700 (3100) is out, 600 (4400) is in.
    const defaults = { ...SCORING_DEFAULTS, aloftMinAboveLaunchM: 1500 };
    const w = aloftWind(perfectHour().build(), 2000, 5000, defaults);
    expect(w).toEqual({ speedMph: 15, dirDeg: 275 });
  });

  it("tiesGoToTheLowestLevel", () => {
    // Not in the Swift suite: pins the tie rule noted in Derived.swift.
    const hour = perfectHour()
      .level(700, (l) => {
        l.windMph = 20;
        l.windDir = 260;
      })
      .build();
    expect(aloftWind(hour, 2000, 6000)).toEqual({ speedMph: 20, dirDeg: 260 });
  });
});

describe("thermalIndex", () => {
  it("perfectHourHandComputed", () => {
    // Launch 2000: lowest level >= 3200 m is 600 hPa (Z 4400, -7.5 C).
    // parcel = 20 - 0.0098 * 2400 = 20 - 23.52 = -3.52; TI = -7.5 - (-3.52) = -3.98.
    const ti = thermalIndex(perfectHour().build(), 2000);
    expect(isClose(ti, -3.98)).toBe(true);
  });

  it("launch1770UsesSixHundred", () => {
    // Needs Z >= 1770 + 1200 = 2970. Z700 must be below that for 600 hPa to be picked;
    // a typical summer Z700 (~3100 m) would qualify and be picked instead.
    // Z700 = 2950 -> 600 hPa (Z 4400, -7.5 C).
    // parcel = 20 - 0.0098 * (4400 - 1770 = 2630) = 20 - 25.774 = -5.774
    // TI = -7.5 - (-5.774) = -1.726
    const hour = perfectHour()
      .level(700, (l) => {
        l.heightM = 2950;
      })
      .build();
    expect(isClose(thermalIndex(hour, 1770), -1.726)).toBe(true);
  });

  it("levelExactlyAtOffsetQualifies", () => {
    // Z700 = 2970 = 1770 + 1200 -> 700 hPa (2 C).
    // parcel = 20 - 0.0098 * 1200 = 8.24; TI = 2 - 8.24 = -6.24
    const hour = perfectHour()
      .level(700, (l) => {
        l.heightM = 2970;
      })
      .build();
    expect(isClose(thermalIndex(hour, 1770), -6.24)).toBe(true);
  });

  it("launch3444UsesFiveHundred", () => {
    // Needs Z >= 3444 + 1200 = 4644. Z600 = 4600 is below -> 500 hPa (Z 5800, -18 C).
    // T2m 12: parcel = 12 - 0.0098 * (5800 - 3444 = 2356) = 12 - 23.0888 = -11.0888
    // TI = -18 - (-11.0888) = -6.9112
    const hour = perfectHour()
      .with((h) => {
        h.tempC = 12;
      })
      .level(600, (l) => {
        l.heightM = 4600;
      })
      .build();
    expect(isClose(thermalIndex(hour, 3444), -6.9112)).toBe(true);
  });

  it("noQualifyingLevelIsNil", () => {
    // Launch 5000 needs >= 6200; Z500 is 5800.
    expect(thermalIndex(perfectHour().build(), 5000)).toBeUndefined();
  });

  it("missingSurfaceTempIsNil", () => {
    const hour = perfectHour()
      .with((h) => {
        h.tempC = undefined;
      })
      .build();
    expect(thermalIndex(hour, 2000)).toBeUndefined();
  });

  it("levelWithoutTempIsSkipped", () => {
    // 600 hPa has no temperature -> next qualifying is 500 hPa (Z 5800, -18 C).
    // parcel = 20 - 0.0098 * 3800 = 20 - 37.24 = -17.24; TI = -18 - (-17.24) = -0.76
    const hour = perfectHour()
      .level(600, (l) => {
        l.tempC = undefined;
      })
      .build();
    expect(isClose(thermalIndex(hour, 2000), -0.76)).toBe(true);
  });
});

describe("cloud base and top of lift", () => {
  it("cloudBaseHandComputed", () => {
    // (20 - 5) * 125 = 1875 m
    expect(isClose(cloudBaseAboveLaunchM(perfectHour().build()), 1875)).toBe(true);
    // (25.4 - 18.2) * 125 = 7.2 * 125 = 900 m
    const humid = perfectHour()
      .with((h) => {
        h.tempC = 25.4;
        h.dewpointC = 18.2;
      })
      .build();
    expect(isClose(cloudBaseAboveLaunchM(humid), 900)).toBe(true);
  });

  it("cloudBaseNilWhenInputMissing", () => {
    const noDew = perfectHour()
      .with((h) => {
        h.dewpointC = undefined;
      })
      .build();
    expect(cloudBaseAboveLaunchM(noDew)).toBeUndefined();
    const noTemp = perfectHour()
      .with((h) => {
        h.tempC = undefined;
      })
      .build();
    expect(cloudBaseAboveLaunchM(noTemp)).toBeUndefined();
  });

  it("topOfLiftUsesLargerOfCloudBaseAndBLH", () => {
    // Perfect: 2000 + max(1875, 2000) = 4000
    expect(isClose(topOfLiftM(perfectHour().build(), 2000), 4000)).toBe(true);
    // BLH 1000: 2000 + max(1875, 1000) = 3875
    const lowBLH = perfectHour()
      .with((h) => {
        h.blhM = 1000;
      })
      .build();
    expect(isClose(topOfLiftM(lowBLH, 2000), 3875)).toBe(true);
  });

  it("topOfLiftWithOneMissing", () => {
    // No BLH: 2000 + 1875 = 3875
    const noBLH = perfectHour()
      .with((h) => {
        h.blhM = undefined;
      })
      .build();
    expect(isClose(topOfLiftM(noBLH, 2000), 3875)).toBe(true);
    // No cloud base: 2000 + 2000 = 4000
    const noCB = perfectHour()
      .with((h) => {
        h.dewpointC = undefined;
      })
      .build();
    expect(isClose(topOfLiftM(noCB, 2000), 4000)).toBe(true);
  });

  it("topOfLiftFallback", () => {
    // Both missing: 2000 + 1500 = 3500
    const neither = perfectHour()
      .with((h) => {
        h.blhM = undefined;
        h.dewpointC = undefined;
      })
      .build();
    expect(isClose(topOfLiftM(neither, 2000), 3500)).toBe(true);
    const defaults = { ...SCORING_DEFAULTS, topOfLiftFallbackAboveLaunchM: 1000 };
    expect(isClose(topOfLiftM(neither, 2000, defaults), 3000)).toBe(true);
  });
});

describe("SCORING_DEFAULTS", () => {
  // Swift's defaultInitIsStandard has no TS equivalent. The frozen check plus the pin below
  // stand in for it.
  it("isFrozen", () => {
    expect(Object.isFrozen(SCORING_DEFAULTS)).toBe(true);
  });

  it("feetThresholdsConvertToMeters", () => {
    // 1500 ft * 0.3048 = 457.2 m; 3000 ft * 0.3048 = 914.4 m
    expect(isClose(lowCloudBaseMarginalM(), 457.2)).toBe(true);
    expect(isClose(cloudBaseBonusM(), 914.4)).toBe(true);
  });

  it("runLengthWeights", () => {
    expect(runLengthWeight(1)).toBe(0.6);
    expect(runLengthWeight(2)).toBe(0.8);
    expect(runLengthWeight(3)).toBe(1.0);
    expect(runLengthWeight(7)).toBe(1.0);
    expect(runLengthWeight(0)).toBe(0);
  });

  it("perfectHourStaysClearOfThresholds", () => {
    // Guards the HourBuilder assumptions that Step 5's baseline test relies on.
    const d = SCORING_DEFAULTS;
    const h = perfectHour().build();
    expect(h.capeJkg).toBeLessThan(d.stormCapeJkg);
    expect(h.gustMph).toBeLessThan(d.gustNoGoMph);
    expect(h.blhM).toBeGreaterThanOrEqual(d.blhBonusMinM);
    expect(cloudBaseAboveLaunchM(h)).toBeGreaterThanOrEqual(cloudBaseBonusM());
    const ti = thermalIndex(h, PERFECT_LAUNCH_ELEVATION_M);
    expect(ti).toBeLessThanOrEqual(d.thermalIndexStrongMaxC);
    const top = topOfLiftM(h, PERFECT_LAUNCH_ELEVATION_M);
    const aloft = aloftWind(h, PERFECT_LAUNCH_ELEVATION_M, top);
    expect(aloft?.speedMph).toBeLessThan(d.aloftMarginalMph);
  });

  // Values copied from Swift's `ScoringDefaults.standard`. The cache intervals are seconds
  // there (cacheMaxAge, forcedRefreshMinInterval) and ms here. Changing one of these
  // is a conscious decision: update the Swift reference and the README criteria with it.
  it("pinsEveryFieldToTheSwiftValue", () => {
    expect(SCORING_DEFAULTS).toStrictEqual({
      precipNoGoMm: 0.25,
      gustNoGoMph: 25,
      variableDirectionBelowMph: 4,
      overTheBackAloftNoGoMph: 20,
      strongAloftNoGoMph: 35,
      neighborMinWindMph: 5,
      neighborMarginalDiffDeg: 60,
      neighborNoGoDiffDeg: 90,
      neighborNoGoMinNeighborMph: 10,
      nearMaxMarginMph: 2,
      capeMarginalJkg: 500,
      aloftMarginalMph: 25,
      lowCloudBaseMarginalFt: 1500,
      lowCloudCoverMarginalPct: 60,
      preThermalBLHBelowM: 500,
      preThermalTIAboveC: 0,
      stormLookaheadHours: 2,
      stormCapeJkg: 200,
      baseScore: 50,
      windSpeedMaxBonus: 20,
      idealDirectionBonus: 10,
      // Web-only: the zero-width ideal-arc fallback (approved 2026-11-08). Not in Swift.
      zeroWidthIdealHalfWidthDeg: 15,
      thermalIndexStrongMaxC: -3,
      thermalIndexStrongBonus: 10,
      thermalIndexModerateMaxC: -1,
      thermalIndexModerateBonus: 5,
      blhBonusMinM: 1500,
      blhBonus: 5,
      cloudBaseBonusMinFt: 3000,
      cloudBaseBonus: 5,
      marginalReasonPenalty: 5,
      gustFactorPenalty: 5,
      minScore: 0,
      maxScore: 100,
      aloftMinAboveLaunchM: 600,
      thermalIndexMinAboveLaunchM: 1200,
      topOfLiftFallbackAboveLaunchM: 1500,
      cloudBaseMPerDegSpread: 125,
      dryAdiabaticLapseCPerM: 0.0098,
      agreementMaxDirDiffDeg: 30,
      agreementCalmBelowMph: 4,
      agreementMaxSpeedDiffMph: 5,
      highConfidenceMinShare: 0.75,
      mediumConfidenceMinShare: 0.4,
      rrfsMinCoverageShare: 0.5,
      oneHourRunWeight: 0.6,
      twoHourRunWeight: 0.8,
      longRunWeight: 1,
      highConfidenceWeight: 1,
      mediumConfidenceWeight: 0.85,
      lowConfidenceWeight: 0.7,
      ecmwfOnlyConfidenceWeight: 0.85,
      cacheMaxAgeMs: 3_600_000,
      forcedRefreshMinIntervalMs: 300_000,
    });
  });
});
