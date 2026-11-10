import { angularDifference } from "../sites/degreeArc";
import { SCORING_DEFAULTS } from "./defaults";
import type { ScoringDefaults } from "./defaults";
import { hasDirection } from "./derived";
import type { HourResult } from "./hourEvaluator";

export type Confidence = "high" | "medium" | "low" | "primaryOnly";

/** True when the check model has a usable result for the hour: one exists and it isn't "noData". */
export function checkCovers(check: HourResult | undefined): check is HourResult {
  return check !== undefined && check.call !== "noData";
}

/**
 * Whether the check model agrees with the primary model for one hour. The check must be covered and
 * not no-go, its launch wind direction within the limit of the primary's at any speed (unless
 * either wind rounds to 0 mph, so has no meaningful direction), and its speed within the limit.
 * Missing launch wind on either side is a disagreement.
 */
export function checkAgrees(
  primary: HourResult,
  check: HourResult | undefined,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): boolean {
  if (!checkCovers(check) || check.call === "noGo") return false;
  const a = primary.launchWind;
  const b = check.launchWind;
  if (a === undefined || b === undefined) return false;
  if (Math.abs(a.speedMph - b.speedMph) > defaults.agreementMaxSpeedDiffMph) return false;
  if (!hasDirection(a) || !hasDirection(b)) return true;
  return angularDifference(a.dirDeg, b.dirDeg) <= defaults.agreementMaxDirDiffDeg;
}

/** Confidence from the share of check-covered hours where the check agrees (not the primaryOnly case). */
export function confidenceForShare(
  share: number,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): "high" | "medium" | "low" {
  if (share >= defaults.highConfidenceMinShare) return "high";
  if (share >= defaults.mediumConfidenceMinShare) return "medium";
  return "low";
}

/**
 * Confidence for a run of primary-model hours. The check model's results are matched by `time`.
 * Agreement is judged over the check-covered hours only. Fewer than `checkMinCoverageShare` of the
 * run covered gives "primaryOnly".
 */
export function runConfidence(
  primaryRun: readonly HourResult[],
  checkByTime: ReadonlyMap<number, HourResult>,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): Confidence {
  let covered = 0;
  let agreeing = 0;
  for (const p of primaryRun) {
    const c = checkByTime.get(p.time);
    if (!checkCovers(c)) continue;
    covered += 1;
    if (checkAgrees(p, c, defaults)) agreeing += 1;
  }
  if (primaryRun.length === 0 || covered / primaryRun.length < defaults.checkMinCoverageShare) {
    return "primaryOnly";
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
    case "primaryOnly":
      return defaults.primaryOnlyConfidenceWeight;
  }
}
