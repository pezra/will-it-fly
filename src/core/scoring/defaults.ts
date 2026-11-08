import { METERS_PER_FOOT } from "../units";

/**
 * Every threshold and weight used to score hours, pick windows and grade model agreement.
 *
 * Units: heights in metres, temperatures in degrees C, winds in mph, unless a name says otherwise
 * (`...Ft` thresholds are kept in feet as the design states them; use the `...M` helpers).
 * Field names and values are identical to the Swift `ScoringDefaults.standard`.
 */
export interface ScoringDefaults {
  // No-go
  /** Precipitation in hour h or h+1 at or above this is no-go. */
  precipNoGoMm: number;
  /** Below this launch wind speed, direction is treated as variable and the direction rules are ignored. */
  variableDirectionBelowMph: number;
  /** Aloft wind at or above this from outside every `ok` arc is no-go (over the back). */
  overTheBackAloftNoGoMph: number;
  /** Aloft wind at or above this from any direction is no-go. */
  strongAloftNoGoMph: number;
  // Neighbor wind (5 mi away)
  /** Both the center and the neighbor 10 m wind must be at least this for the check to apply. */
  neighborMinWindMph: number;
  /** A direction difference greater than this is a caution. */
  neighborCautionDiffDeg: number;
  /** A direction difference greater than this is no-go. */
  neighborNoGoDiffDeg: number;
  /** A difference > `neighborCautionDiffDeg` with the neighbor at or above this is no-go. */
  neighborNoGoMinNeighborMph: number;
  // Caution
  /** Launch wind within this of the site's max is a caution. */
  nearMaxMarginMph: number;
  /** CAPE at or above this is a caution ("overdevelopment risk"). */
  capeCautionJkg: number;
  /** Aloft wind at or above this (and not already no-go) is a caution. */
  aloftCautionMph: number;
  /** Computed cloud base below this many feet above launch is a caution. */
  lowCloudBaseCautionFt: number;
  /** `cloud_cover_low` at or above this percentage is a caution. */
  lowCloudCoverCautionPct: number;
  // Penalty (scored, never changes the call)
  /** Sledder: BLH below this (m above model terrain) ... */
  sledderBLHBelowM: number;
  /**
   * ... and TI above this (degrees C) gives "sledder". A penalty, not a caution, since
   * 2026-11-08: it fired all day on weak days that were still soarable.
   */
  sledderTIAboveC: number;
  // Bonus (scored, never changes the call)
  /** Ridge lift: the launch wind is in an ideal arc and at least this fast (a site can override). */
  ridgeLiftMinMph: number;
  ridgeLiftBonus: number;
  /** XC: the thermal index is at most `thermalIndexStrongMaxC` and the BLH at least this (m). */
  xcBlhMinM: number;
  xcBonus: number;
  // Warnings (shown, never scored)
  /**
   * A gust factor at or above this multiple of the site's gust-factor limit warns "high gusts
   * possible". Forecast gusts drive no call or score. Not in the Swift defaults: added when the
   * author took gusts out of scoring on 2026-11-08 (Swift's `gustNoGoMph` and `gustFactorPenalty`
   * were dropped).
   */
  highGustWarningFactorMultiple: number;
  // Storm look-ahead
  /** Hours before a convective no-go that are capped at flyable ("storms forecast by HH:00"). */
  stormLookaheadHours: number;
  /** A precipitation no-go hour is convective when max(CAPE h, CAPE h+1) is at least this. */
  stormCapeJkg: number;
  // Score
  /** Non-no-go hours start here. No-go hours score `minScore`. */
  baseScore: number;
  /** Wind bonus at the ideal speed, falling linearly to 0 at the site's min and max. */
  windSpeedMaxBonus: number;
  /** Bonus when the launch wind direction is in an `ideal` arc. */
  idealDirectionBonus: number;
  /**
   * A zero-width `ideal` arc (from === to) counts as that heading plus or minus this. Not in the
   * Swift defaults: added for the ideal-arc fallback the user approved on 2026-11-08.
   */
  zeroWidthIdealHalfWidthDeg: number;
  /** TI at or below this (degrees C) earns `thermalIndexStrongBonus`. */
  thermalIndexStrongMaxC: number;
  thermalIndexStrongBonus: number;
  /** Otherwise, TI at or below this (degrees C) earns `thermalIndexModerateBonus`. */
  thermalIndexModerateMaxC: number;
  thermalIndexModerateBonus: number;
  /** BLH at or above this (m) earns `blhBonus`. */
  blhBonusMinM: number;
  blhBonus: number;
  /** Cloud base at or above this many feet above launch earns `cloudBaseBonus`. */
  cloudBaseBonusMinFt: number;
  cloudBaseBonus: number;
  /** Subtracted once per caution or penalty reason. */
  cautionReasonPenalty: number;
  minScore: number;
  maxScore: number;
  // Derived values
  /** Aloft wind considers levels at least this far above launch. */
  aloftMinAboveLaunchM: number;
  /** Thermal index uses the lowest level at least this far above launch. */
  thermalIndexMinAboveLaunchM: number;
  /** Top of lift when both cloud base and BLH are missing: launch + this. */
  topOfLiftFallbackAboveLaunchM: number;
  /** Cloud base above launch = (T - Td) x this. */
  cloudBaseMPerDegSpread: number;
  /** Dry adiabatic lapse rate for the TI parcel. */
  dryAdiabaticLapseCPerM: number;
  // Model agreement
  /** RRFS agrees when its launch wind direction is within this of ECMWF's ... */
  agreementMaxDirDiffDeg: number;
  /** ... or both launch winds are below this (direction ignored) ... */
  agreementCalmBelowMph: number;
  /** ... and its launch wind speed is within this of ECMWF's. */
  agreementMaxSpeedDiffMph: number;
  /** Share of RRFS-covered hours agreeing for high confidence. */
  highConfidenceMinShare: number;
  /** Share of RRFS-covered hours agreeing for medium confidence. Below is low. */
  mediumConfidenceMinShare: number;
  /** If RRFS covers less than this share of a run's hours, confidence is "ECMWF only". */
  rrfsMinCoverageShare: number;
  // Window score weights
  oneHourRunWeight: number;
  twoHourRunWeight: number;
  /** Runs of 3 hours or more. */
  longRunWeight: number;
  highConfidenceWeight: number;
  mediumConfidenceWeight: number;
  lowConfidenceWeight: number;
  ecmwfOnlyConfidenceWeight: number;
  // Cache
  /** A cached forecast younger than this (ms) is used without fetching. */
  cacheMaxAgeMs: number;
  /** A forced refresh within this long (ms) of the last fetch uses the cache. */
  forcedRefreshMinIntervalMs: number;
}

export const SCORING_DEFAULTS: Readonly<ScoringDefaults> = Object.freeze({
  // No-go
  precipNoGoMm: 0.25,
  variableDirectionBelowMph: 4,
  overTheBackAloftNoGoMph: 20,
  strongAloftNoGoMph: 35,
  // Neighbor wind (5 mi away)
  neighborMinWindMph: 5,
  neighborCautionDiffDeg: 60,
  neighborNoGoDiffDeg: 90,
  neighborNoGoMinNeighborMph: 10,
  // Caution
  nearMaxMarginMph: 2,
  capeCautionJkg: 500,
  aloftCautionMph: 25,
  lowCloudBaseCautionFt: 1500,
  lowCloudCoverCautionPct: 60,
  // Penalty (scored, never changes the call)
  sledderBLHBelowM: 500,
  sledderTIAboveC: 0,
  // Bonus (scored, never changes the call)
  ridgeLiftMinMph: 8,
  ridgeLiftBonus: 10,
  xcBlhMinM: 2000,
  xcBonus: 5,
  // Warnings (shown, never scored)
  highGustWarningFactorMultiple: 3,
  // Storm look-ahead
  stormLookaheadHours: 2,
  stormCapeJkg: 200,
  // Score
  baseScore: 50,
  windSpeedMaxBonus: 20,
  idealDirectionBonus: 10,
  zeroWidthIdealHalfWidthDeg: 15,
  thermalIndexStrongMaxC: -3,
  thermalIndexStrongBonus: 10,
  thermalIndexModerateMaxC: -1,
  thermalIndexModerateBonus: 5,
  blhBonusMinM: 1500,
  blhBonus: 5,
  cloudBaseBonusMinFt: 3000,
  cloudBaseBonus: 5,
  cautionReasonPenalty: 5,
  minScore: 0,
  maxScore: 100,
  // Derived values
  aloftMinAboveLaunchM: 600,
  thermalIndexMinAboveLaunchM: 1200,
  topOfLiftFallbackAboveLaunchM: 1500,
  cloudBaseMPerDegSpread: 125,
  dryAdiabaticLapseCPerM: 0.0098,
  // Model agreement
  agreementMaxDirDiffDeg: 30,
  agreementCalmBelowMph: 4,
  agreementMaxSpeedDiffMph: 5,
  highConfidenceMinShare: 0.75,
  mediumConfidenceMinShare: 0.4,
  rrfsMinCoverageShare: 0.5,
  // Window score weights
  oneHourRunWeight: 0.6,
  twoHourRunWeight: 0.8,
  longRunWeight: 1,
  highConfidenceWeight: 1,
  mediumConfidenceWeight: 0.85,
  lowConfidenceWeight: 0.7,
  ecmwfOnlyConfidenceWeight: 0.85,
  // Cache
  cacheMaxAgeMs: 60 * 60 * 1000,
  forcedRefreshMinIntervalMs: 5 * 60 * 1000,
} as const satisfies ScoringDefaults);

export function lowCloudBaseCautionM(defaults: ScoringDefaults = SCORING_DEFAULTS): number {
  return defaults.lowCloudBaseCautionFt * METERS_PER_FOOT;
}

export function cloudBaseBonusM(defaults: ScoringDefaults = SCORING_DEFAULTS): number {
  return defaults.cloudBaseBonusMinFt * METERS_PER_FOOT;
}

/** The run-length weight for a run of `hours` hours (0 for an empty run). */
export function runLengthWeight(
  hours: number,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): number {
  if (hours < 1) return 0;
  if (hours === 1) return defaults.oneHourRunWeight;
  if (hours === 2) return defaults.twoHourRunWeight;
  return defaults.longRunWeight;
}
