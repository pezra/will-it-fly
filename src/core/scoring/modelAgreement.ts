import { angularDifference } from "../sites/degreeArc";
import { SCORING_DEFAULTS } from "./defaults";
import type { ScoringDefaults } from "./defaults";
import type { HourResult } from "./hourEvaluator";

export type Confidence = "high" | "medium" | "low" | "ecmwfOnly";

/** True when RRFS has a usable result for the hour: one exists and it isn't "noData". */
export function rrfsCovers(rrfs: HourResult | undefined): rrfs is HourResult {
  return rrfs !== undefined && rrfs.call !== "noData";
}

/**
 * Whether RRFS agrees with ECMWF for one hour. RRFS must be covered and not no-go, its launch wind
 * direction within the limit of ECMWF's (or both winds calm), and its speed within the limit.
 * Calm waives only the direction check. Missing launch wind on either side is a disagreement.
 */
export function rrfsAgrees(
  ecmwf: HourResult,
  rrfs: HourResult | undefined,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): boolean {
  if (!rrfsCovers(rrfs) || rrfs.call === "noGo") return false;
  const a = ecmwf.launchWind;
  const b = rrfs.launchWind;
  if (a === undefined || b === undefined) return false;
  if (Math.abs(a.speedMph - b.speedMph) > defaults.agreementMaxSpeedDiffMph) return false;
  const bothCalm =
    a.speedMph < defaults.agreementCalmBelowMph && b.speedMph < defaults.agreementCalmBelowMph;
  return bothCalm || angularDifference(a.dirDeg, b.dirDeg) <= defaults.agreementMaxDirDiffDeg;
}

/** Confidence from the share of RRFS-covered hours where RRFS agrees (not the ecmwfOnly case). */
export function confidenceForShare(
  share: number,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): "high" | "medium" | "low" {
  if (share >= defaults.highConfidenceMinShare) return "high";
  if (share >= defaults.mediumConfidenceMinShare) return "medium";
  return "low";
}

/**
 * Confidence for a run of ECMWF hours. RRFS results are matched by `time`. Agreement is judged over
 * the RRFS-covered hours only. Fewer than `rrfsMinCoverageShare` of the run covered gives "ecmwfOnly".
 */
export function runConfidence(
  ecmwfRun: readonly HourResult[],
  rrfsByTime: ReadonlyMap<number, HourResult>,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): Confidence {
  let covered = 0;
  let agreeing = 0;
  for (const e of ecmwfRun) {
    const r = rrfsByTime.get(e.time);
    if (!rrfsCovers(r)) continue;
    covered += 1;
    if (rrfsAgrees(e, r, defaults)) agreeing += 1;
  }
  if (ecmwfRun.length === 0 || covered / ecmwfRun.length < defaults.rrfsMinCoverageShare) {
    return "ecmwfOnly";
  }
  return confidenceForShare(agreeing / covered, defaults);
}

/** Confidence weight for a window. */
export function confidenceWeight(
  confidence: Confidence,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): number {
  switch (confidence) {
    case "high":
      return defaults.highConfidenceWeight;
    case "medium":
      return defaults.mediumConfidenceWeight;
    case "low":
      return defaults.lowConfidenceWeight;
    case "ecmwfOnly":
      return defaults.ecmwfOnlyConfidenceWeight;
  }
}
