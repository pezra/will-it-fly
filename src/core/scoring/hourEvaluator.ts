import type { ModelHour, NeighborWind } from "../forecast/models";
import { NEIGHBOR_DISTANCE_M } from "../forecast/openMeteoClient";
import { angularDifference, arcsContain, degreesOutsideArcs } from "../sites/degreeArc";
import type { DegreeArc, Launch, Site, WindLimits } from "../sites/site";
import { effectiveLimits, elevationM } from "../sites/site";
import { HOUR_MS, byTime, formatDenverTime } from "../time";
import { METERS_PER_FOOT, METERS_PER_MILE, compass, definedMax, mph } from "../units";
import { SCORING_DEFAULTS, cloudBaseBonusM, lowCloudBaseCautionM } from "./defaults";
import type { ScoringDefaults } from "./defaults";
import {
  aloftWind,
  cloudBaseAboveLaunchM,
  hasDirection,
  launchWind,
  thermalIndex,
  topOfLiftM,
} from "./derived";
import type { Wind } from "./derived";

/** The forecast models, the single definition: the route, the saved default and the UI read it. */
export const MODEL_NAMES = ["ecmwf", "rrfs"] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

export function isModelName(value: unknown): value is ModelName {
  return (MODEL_NAMES as readonly unknown[]).includes(value);
}

export type HourCall = "good" | "flyable" | "noGo" | "noData";

/**
 * A `"bonus"` is a favorable condition that adds points but never changes an hour's call.
 * A `"penalty"` costs points but never changes an hour's call. A `"warning"` is shown to the pilot
 * but never changes an hour's call or score.
 */
export type Severity = "info" | "bonus" | "warning" | "penalty" | "caution" | "noGo";

/**
 * Every reason kind, declared roughly most-severe first: no-go kinds, then caution, then penalty,
 * then bonus, then warning, then info ("n/a"). Ties in reason counts are broken by this order.
 */
export const REASON_KIND_ORDER = [
  // No-go
  "noData",
  "precipitation",
  "windTooStrong",
  "windTooWeak",
  "wrongDirection",
  "overTheBack",
  "strongAloft",
  "neighborWindStrong",
  "neighborOffDirectionStrong",
  // Caution
  "stormsComing",
  "rrfsSeesStorms",
  "ecmwfSeesStorms",
  "overdevelopment",
  "aloftWind",
  "nearMaxWind",
  "lowCloud",
  "neighborWind",
  "neighborOffDirection",
  "directionNotIdeal",
  "notCurated",
  // Penalty: scored, never changes the call
  "sledder",
  // Bonus: scored, never changes the call
  "ridgeLift",
  "xcPotential",
  // Warning: shown, never scored
  "highGusts",
  // Info: a rule or score factor skipped for missing data
  "capeUnavailable",
  "aloftWindUnavailable",
  "cloudBaseUnavailable",
  "lowCloudCoverUnavailable",
  "blhUnavailable",
  "thermalIndexUnavailable",
  "neighborUnavailable",
] as const;

export type ReasonKind = (typeof REASON_KIND_ORDER)[number];

const REASON_RANK: ReadonlyMap<ReasonKind, number> = new Map(
  REASON_KIND_ORDER.map((kind, i) => [kind, i] as const),
);

/** A kind's position in `REASON_KIND_ORDER` (lower is more severe). */
export function reasonRank(kind: ReasonKind): number {
  return REASON_RANK.get(kind) ?? REASON_KIND_ORDER.length;
}

/** Each kind has exactly one severity. */
export const REASON_SEVERITY: Readonly<Record<ReasonKind, Severity>> = Object.freeze({
  noData: "noGo",
  precipitation: "noGo",
  windTooStrong: "noGo",
  windTooWeak: "noGo",
  wrongDirection: "noGo",
  overTheBack: "noGo",
  strongAloft: "noGo",
  neighborWindStrong: "noGo",
  neighborOffDirectionStrong: "noGo",
  stormsComing: "caution",
  rrfsSeesStorms: "caution",
  ecmwfSeesStorms: "caution",
  overdevelopment: "caution",
  aloftWind: "caution",
  nearMaxWind: "caution",
  lowCloud: "caution",
  neighborWind: "caution",
  neighborOffDirection: "caution",
  directionNotIdeal: "caution",
  notCurated: "caution",
  sledder: "penalty",
  ridgeLift: "bonus",
  xcPotential: "bonus",
  highGusts: "warning",
  capeUnavailable: "info",
  aloftWindUnavailable: "info",
  cloudBaseUnavailable: "info",
  lowCloudCoverUnavailable: "info",
  blhUnavailable: "info",
  thermalIndexUnavailable: "info",
  neighborUnavailable: "info",
});

export interface Reason {
  kind: ReasonKind;
  severity: Severity;
  /** Display string. */
  text: string;
}

/** What kind of flying an hour offers. */
export type HourCondition = "soar" | "xc" | "sledder";

export interface HourResult {
  /** Start of the flying hour (epoch ms), from the evaluated `ModelHour`. */
  time: number;
  call: HourCall;
  /** 0 to 100. No-go and no-data hours score `minScore`. */
  score: number;
  /** At most one reason per kind, in `REASON_KIND_ORDER`. */
  reasons: Reason[];
  /** The launch wind used for the speed and direction checks. Undefined when it's missing. */
  launchWind?: Wind | undefined;
  /**
   * Base score plus bonuses, before caution penalties and clamping. Kept so the storm look-ahead
   * can add a reason and recompute the score exactly.
   */
  unpenalizedScore: number;
  /** Cloud base above launch (m), as evaluated. Undefined when it can't be computed. */
  cloudBaseM?: number | undefined;
  /** Thermal index (°C), as evaluated. Undefined when it can't be computed. */
  thermalIndexC?: number | undefined;
  /** Soar and/or XC, in that order, or just sledder when neither applies. Empty for no-go and no-data hours. */
  conditions: HourCondition[];
}

/** The fields of a result that don't depend on its reasons. */
type HourFields = Pick<
  HourResult,
  "time" | "launchWind" | "unpenalizedScore" | "cloudBaseM" | "thermalIndexC" | "conditions"
>;

/** One point's 10 m wind at the evaluated hour, for each model. */
export interface NeighborSample {
  ecmwf?: NeighborWind | undefined;
  rrfs?: NeighborWind | undefined;
}

export interface NeighborPointSample extends NeighborSample {
  bearingDeg: number;
}

/**
 * Everything needed to evaluate one launch for one hour with one model. The caller aligns every
 * series to the evaluated hour.
 */
export interface HourContext {
  model: ModelName;
  hour: ModelHour;
  /** The following hour of the same model. Undefined at the last hour: hour h is used alone. */
  next?: ModelHour | undefined;
  /** The other model's hour and its next hour, for the primary model's evaluation only. */
  other?: { hour: ModelHour | undefined; next: ModelHour | undefined } | undefined;
  /** The neighbor request's center 10 m wind at h, per model (not the launch request's wind). */
  neighborCenter: NeighborSample;
  /** Each neighbor's 10 m wind at h, per model. */
  neighbors: readonly NeighborPointSample[];
  launch: Launch;
  site: Site;
}

/** The model's name as shown to the pilot. */
export const MODEL_LABEL: Readonly<Record<ModelName, string>> = { ecmwf: "ECMWF", rrfs: "RRFS" };
/** The model that cross-checks each primary model. */
export const CHECK_MODEL: Readonly<Record<ModelName, ModelName>> = { ecmwf: "rrfs", rrfs: "ecmwf" };
/** The reason a primary model's hour gets when its check model has a precipitation no-go. */
const SEES_STORMS: Readonly<Record<ModelName, ReasonKind>> = {
  ecmwf: "rrfsSeesStorms",
  rrfs: "ecmwfSeesStorms",
};

function windText(w: Wind): string {
  return `${compass(w.dirDeg)} ${mph(w.speedMph)}`;
}

function reason(kind: ReasonKind, text: string): Reason {
  return { kind, severity: REASON_SEVERITY[kind], text };
}

export function sortedReasons(reasons: Reason[]): Reason[] {
  return [...reasons].sort((a, b) => reasonRank(a.kind) - reasonRank(b.kind));
}

/** The call and score from a reason list and the unpenalized score. */
function finish(fields: HourFields, reasons: Reason[], defaults: ScoringDefaults): HourResult {
  const { unpenalizedScore } = fields;
  const sorted = sortedReasons(reasons);
  const has = (s: Severity) => sorted.some((r) => r.severity === s);
  let call: HourCall;
  if (sorted.some((r) => r.kind === "noData")) call = "noData";
  else if (has("noGo")) call = "noGo";
  else if (has("caution")) call = "flyable";
  else call = "good";

  let score = defaults.minScore;
  if (call === "good" || call === "flyable") {
    // Warnings and info reasons cost nothing.
    let count = sorted.filter((r) => r.severity === "caution" || r.severity === "penalty").length;
    // The two nearby-wind cautions cost one penalty together.
    if (sorted.some((r) => r.kind === "neighborWind") && sorted.some((r) => r.kind === "neighborOffDirection")) {
      count -= 1;
    }
    const penalties = count * defaults.cautionReasonPenalty;
    score = Math.min(defaults.maxScore, Math.max(defaults.minScore, unpenalizedScore - penalties));
  }
  return {
    time: fields.time,
    call,
    score,
    reasons: sorted,
    launchWind: fields.launchWind,
    unpenalizedScore,
    cloudBaseM: fields.cloudBaseM,
    thermalIndexC: fields.thermalIndexC,
    conditions: call === "noGo" || call === "noData" ? [] : fields.conditions,
  };
}

/**
 * The ideal arcs with the fallback applied: an empty list means anywhere in `ok`, and a
 * zero-width arc (from === to) means that heading plus or minus the half-width.
 */
export function effectiveIdealArcs(launch: Launch, defaults: ScoringDefaults): DegreeArc[] {
  const { ok, ideal } = launch.directions;
  if (ideal.length === 0) return ok;
  const half = defaults.zeroWidthIdealHalfWidthDeg;
  return ideal.map((arc) => (arc.from === arc.to ? { from: arc.from - half, to: arc.from + half } : arc));
}

/** +max bonus at the ideal speed, falling linearly to 0 at min and max. */
function windBonus(speed: number, limits: WindLimits, defaults: ScoringDefaults): number {
  const { minMph: min, maxMph: max } = limits;
  const ideal = Math.min(max, Math.max(min, limits.idealMph ?? (min + max) / 2));
  let fraction: number;
  if (speed <= ideal) fraction = ideal > min ? (speed - min) / (ideal - min) : 1;
  else fraction = max > ideal ? (max - speed) / (max - ideal) : 0;
  return defaults.windSpeedMaxBonus * Math.min(1, Math.max(0, fraction));
}

function toWind(w: NeighborWind | undefined): Wind | undefined {
  if (w?.windMph === undefined || w.windDir === undefined) return undefined;
  return { speedMph: w.windMph, dirDeg: w.windDir };
}

/** The neighbor points' distance from the launch, in whole miles, as the reasons show it. */
const NEIGHBOR_MILES = Math.round(NEIGHBOR_DISTANCE_M / METERS_PER_MILE);

/**
 * The model both neighbor checks read: RRFS when its center and at least one neighbor have wind,
 * else ECMWF on the same test, else undefined. Its center and the neighbors that have wind.
 */
function neighborModelWinds(
  ctx: HourContext,
): { model: ModelName; center: Wind; points: { bearingDeg: number; wind: Wind }[] } | undefined {
  for (const model of ["rrfs", "ecmwf"] as const) {
    const center = toWind(ctx.neighborCenter[model]);
    if (center === undefined) continue;
    const points = ctx.neighbors.flatMap((p) => {
      const wind = toWind(p[model]);
      return wind === undefined ? [] : [{ bearingDeg: p.bearingDeg, wind }];
    });
    if (points.length > 0) return { model, center, points };
  }
  return undefined;
}

/**
 * The neighbor check: one model on both sides (center 10 m vs neighbor 10 m), from
 * `neighborModelWinds`, else "n/a". Returns at most one reason, naming the worst neighbor.
 */
function neighborReason(ctx: HourContext, defaults: ScoringDefaults): Reason | undefined {
  const winds = neighborModelWinds(ctx);
  if (winds === undefined) return reason("neighborUnavailable", "wind nearby: n/a");
  const { model, center, points } = winds;

  let worst: { kind: ReasonKind; diff: number; bearingDeg: number; wind: Wind } | undefined;
  for (const { bearingDeg, wind } of points) {
    if (center.speedMph < defaults.neighborMinWindMph || wind.speedMph < defaults.neighborMinWindMph) {
      continue;
    }
    const diff = angularDifference(center.dirDeg, wind.dirDeg);
    if (diff <= defaults.neighborCautionDiffDeg) continue;
    const noGo =
      diff > defaults.neighborNoGoDiffDeg || wind.speedMph >= defaults.neighborNoGoMinNeighborMph;
    const kind: ReasonKind = noGo ? "neighborWindStrong" : "neighborWind";
    const better =
      worst === undefined ||
      (noGo && worst.kind !== "neighborWindStrong") ||
      (noGo === (worst.kind === "neighborWindStrong") && diff > worst.diff);
    if (better) worst = { kind, diff, bearingDeg, wind };
  }
  if (worst === undefined) return undefined;
  return reason(
    worst.kind,
    `inconsistent wind nearby: ${NEIGHBOR_MILES} mi ${compass(worst.bearingDeg)}: ${windText(worst.wind)} (${MODEL_LABEL[model]})`,
  );
}

/**
 * The off-direction check: a neighbor 10 m wind from outside every `ok` arc, from the same model
 * as the neighbor check. Only the neighbor's own wind counts, not the center's or the launch's.
 * Returns at most one reason, naming the worst neighbor: any no-go first, then the farthest outside.
 */
function offDirectionNeighborReason(ctx: HourContext, defaults: ScoringDefaults): Reason | undefined {
  const { ok } = ctx.launch.directions;
  if (ok.length === 0) return undefined;
  const winds = neighborModelWinds(ctx);
  if (winds === undefined) return undefined;

  let worst: { noGo: boolean; out: number; bearingDeg: number; wind: Wind } | undefined;
  for (const { bearingDeg, wind } of winds.points) {
    if (wind.speedMph < defaults.neighborOffDirectionMinMph) continue;
    const out = degreesOutsideArcs(ok, wind.dirDeg);
    if (out === 0) continue;
    const noGo =
      out > defaults.neighborOffDirectionNoGoMarginDeg && wind.speedMph >= defaults.neighborOffDirectionNoGoMinMph;
    if (worst === undefined || (noGo && !worst.noGo) || (noGo === worst.noGo && out > worst.out)) {
      worst = { noGo, out, bearingDeg, wind };
    }
  }
  if (worst === undefined) return undefined;
  return reason(
    worst.noGo ? "neighborOffDirectionStrong" : "neighborOffDirection",
    `off-direction wind ${NEIGHBOR_MILES} mi ${compass(worst.bearingDeg)}: ${windText(worst.wind)}`,
  );
}

/** Precipitation for the flying hour: the preceding-hour values, so max(h, h+1). */
function precipMaxMm(hour: ModelHour, next: ModelHour | undefined): number | undefined {
  return definedMax(hour.precipMm, next?.precipMm);
}

/** The flying hour's precipitation (mm) when it is a no-go by max(h, h+1), else undefined. */
function precipNoGoMm(hour: ModelHour, next: ModelHour | undefined, defaults: ScoringDefaults): number | undefined {
  const precip = precipMaxMm(hour, next);
  return precip !== undefined && precip >= defaults.precipNoGoMm ? precip : undefined;
}

/**
 * The gust factor for the flying hour: the larger of each hour's gust minus its own 10 m wind (same
 * model), at least 0. Undefined when neither hour has both values.
 */
function gustFactorMph(hour: ModelHour, next: ModelHour | undefined): number | undefined {
  const terms = [hour, next].flatMap((h) =>
    h?.gustMph === undefined || h.windMph === undefined ? [] : [h.gustMph - h.windMph],
  );
  return terms.length === 0 ? undefined : Math.max(0, ...terms);
}

/** The core fields an hour lacks: the launch wind (10 m speed and direction) and precipitation at h. */
function missingCoreFields(hour: ModelHour, wind: Wind | undefined): string[] {
  const missing: string[] = [];
  if (wind === undefined) missing.push("wind");
  if (hour.precipMm === undefined) missing.push("precipitation");
  return missing;
}

/** True when the hour has the core fields, so `evaluateHour` won't call it no data. */
export function hasCoreData(hour: ModelHour, launch: Launch): boolean {
  return missingCoreFields(hour, launchWind(hour, elevationM(launch))).length === 0;
}

/** The per-hour call, score and reasons for one launch and one model. */
export function evaluateHour(ctx: HourContext, defaults: ScoringDefaults = SCORING_DEFAULTS): HourResult {
  const { hour, next, launch } = ctx;
  const elev = elevationM(launch);
  const wind = launchWind(hour, elev);
  // Shown for every hour, no-data ones included.
  const cloudBase = cloudBaseAboveLaunchM(hour, defaults);
  const ti = thermalIndex(hour, elev, defaults);
  const fields = (unpenalizedScore: number, conditions: HourCondition[] = []): HourFields => ({
    time: hour.time,
    launchWind: wind,
    unpenalizedScore,
    cloudBaseM: cloudBase,
    thermalIndexC: ti,
    conditions,
  });

  const missing = missingCoreFields(hour, wind);
  if (wind === undefined || missing.length > 0) {
    return finish(fields(0), [reason("noData", `no data: ${missing.join(", ")}`)], defaults);
  }

  const reasons: Reason[] = [];
  const limits = effectiveLimits(ctx.site, launch);
  const { ok } = launch.directions;
  const curated = ok.length > 0;

  // Precipitation and gusts: the preceding-hour values, so max(h, h+1).
  const precip = precipNoGoMm(hour, next, defaults);
  if (precip !== undefined) {
    reasons.push(reason("precipitation", `rain ${precip.toFixed(1)} mm`));
  }
  // Forecast gusts are not scored, only warned about. A missing gust gives no reason at all.
  const factor = gustFactorMph(hour, next);
  if (factor !== undefined && factor >= defaults.highGustWarningFactorMultiple * limits.gustFactorMph) {
    reasons.push(reason("highGusts", `high gusts possible (gust factor ${mph(factor)})`));
  }

  // Launch wind speed.
  if (wind.speedMph > limits.maxMph) {
    reasons.push(reason("windTooStrong", `wind ${mph(wind.speedMph)} over max ${mph(limits.maxMph)}`));
  } else if (wind.speedMph >= limits.maxMph - defaults.nearMaxMarginMph) {
    reasons.push(reason("nearMaxWind", `wind ${mph(wind.speedMph)} near max ${mph(limits.maxMph)}`));
  }
  if (limits.minMph > 0 && wind.speedMph < limits.minMph) {
    reasons.push(reason("windTooWeak", `wind ${mph(wind.speedMph)} under min ${mph(limits.minMph)}`));
  }

  // Launch wind direction, unless the wind rounds to 0 mph.
  let inIdeal = false;
  if (!curated) {
    reasons.push(reason("notCurated", "launch direction not curated"));
  } else if (hasDirection(wind)) {
    if (!arcsContain(ok, wind.dirDeg)) {
      reasons.push(reason("wrongDirection", `wind from ${compass(wind.dirDeg)}, outside launch directions`));
    } else if (arcsContain(effectiveIdealArcs(launch, defaults), wind.dirDeg)) {
      inIdeal = true;
    } else {
      reasons.push(reason("directionNotIdeal", `wind from ${compass(wind.dirDeg)}, not ideal`));
    }
  }

  // Aloft.
  const aloft = aloftWind(hour, elev, topOfLiftM(hour, elev, defaults), defaults);
  if (aloft === undefined) {
    reasons.push(reason("aloftWindUnavailable", "wind aloft: n/a"));
  } else {
    const strong = aloft.speedMph >= defaults.strongAloftNoGoMph;
    const overTheBack =
      curated && aloft.speedMph >= defaults.overTheBackAloftNoGoMph && !arcsContain(ok, aloft.dirDeg);
    if (strong) reasons.push(reason("strongAloft", `wind aloft ${windText(aloft)}`));
    if (overTheBack) reasons.push(reason("overTheBack", `over the back aloft: ${windText(aloft)}`));
    if (!strong && !overTheBack && aloft.speedMph >= defaults.aloftCautionMph) {
      reasons.push(reason("aloftWind", `wind aloft ${windText(aloft)}`));
    }
  }

  // CAPE (instantaneous, hour h).
  if (hour.capeJkg === undefined) {
    reasons.push(reason("capeUnavailable", "CAPE: n/a"));
  } else if (hour.capeJkg >= defaults.capeCautionJkg) {
    reasons.push(reason("overdevelopment", `overdevelopment risk (CAPE ${Math.round(hour.capeJkg)} J/kg)`));
  }

  // Low cloud.
  const lowCloud: string[] = [];
  if (cloudBase === undefined) {
    reasons.push(reason("cloudBaseUnavailable", "cloud base: n/a"));
  } else if (cloudBase < lowCloudBaseCautionM(defaults)) {
    lowCloud.push(`base ≈${Math.round(cloudBase / METERS_PER_FOOT)} ft above launch`);
  }
  if (hour.lowCloudPct === undefined) {
    reasons.push(reason("lowCloudCoverUnavailable", "low cloud cover: n/a"));
  } else if (hour.lowCloudPct >= defaults.lowCloudCoverCautionPct) {
    lowCloud.push(`${Math.round(hour.lowCloudPct)}% low cloud`);
  }
  if (lowCloud.length > 0) reasons.push(reason("lowCloud", `low cloud: ${lowCloud.join(", ")}`));

  // Wind nearby.
  const neighbor = neighborReason(ctx, defaults);
  if (neighbor !== undefined) reasons.push(neighbor);
  const offDirection = offDirectionNeighborReason(ctx, defaults);
  if (offDirection !== undefined) reasons.push(offDirection);

  // Ridge lift: the wind is on the ridge, in an ideal arc and fast enough to soar.
  const soaring = ctx.site.soaring;
  const ridgeLift =
    soaring !== undefined &&
    (soaring.launchIds === undefined || soaring.launchIds.includes(launch.id)) &&
    curated &&
    wind.speedMph >= (soaring.minMph ?? defaults.ridgeLiftMinMph) &&
    arcsContain(effectiveIdealArcs(launch, defaults), wind.dirDeg);
  if (ridgeLift) reasons.push(reason("ridgeLift", `ridge lift: ${windText(wind)} on the ridge`));

  // Sledder: BLH low and TI positive. With one missing, the other decides. Ridge lift waives it.
  const blh = hour.blhM;
  if (blh === undefined) reasons.push(reason("blhUnavailable", "BLH: n/a"));
  if (ti === undefined) reasons.push(reason("thermalIndexUnavailable", "thermal index: n/a"));
  if (blh !== undefined || ti !== undefined) {
    const lowBLH = blh === undefined || blh < defaults.sledderBLHBelowM;
    const stableTI = ti === undefined || ti > defaults.sledderTIAboveC;
    if (lowBLH && stableTI && !ridgeLift) reasons.push(reason("sledder", "sledder"));
  }

  // XC: strong thermals that top out high, with the wind aloft not already a caution. The bonus
  // and reason need a curated xc site; the condition label doesn't.
  const thermalXC =
    ti !== undefined &&
    ti <= defaults.thermalIndexStrongMaxC &&
    blh !== undefined &&
    blh >= defaults.xcBlhMinM &&
    aloft !== undefined &&
    aloft.speedMph < defaults.aloftCautionMph;
  const xcPotential = thermalXC && ctx.site.xc !== undefined;
  if (xcPotential && ti !== undefined && blh !== undefined) {
    reasons.push(reason("xcPotential", `XC potential (thermal index ${ti.toFixed(1)} °C, BLH ${Math.round(blh)} m)`));
  }

  // The other model sees storms (primary model evaluation only).
  if (ctx.other?.hour !== undefined) {
    if (precipNoGoMm(ctx.other.hour, ctx.other.next, defaults) !== undefined) {
      reasons.push(reason(SEES_STORMS[ctx.model], `${MODEL_LABEL[CHECK_MODEL[ctx.model]]} sees storms`));
    }
  }

  // Score bonuses.
  let unpenalized = defaults.baseScore + windBonus(wind.speedMph, limits, defaults);
  if (ridgeLift) unpenalized += defaults.ridgeLiftBonus;
  if (xcPotential) unpenalized += defaults.xcBonus;
  if (inIdeal) unpenalized += defaults.idealDirectionBonus;
  if (ti !== undefined) {
    if (ti <= defaults.thermalIndexStrongMaxC) unpenalized += defaults.thermalIndexStrongBonus;
    else if (ti <= defaults.thermalIndexModerateMaxC) unpenalized += defaults.thermalIndexModerateBonus;
  }
  if (blh !== undefined && blh >= defaults.blhBonusMinM) unpenalized += defaults.blhBonus;
  if (cloudBase !== undefined && cloudBase >= cloudBaseBonusM(defaults)) {
    unpenalized += defaults.cloudBaseBonus;
  }

  const conditions: HourCondition[] = [];
  if (ridgeLift) conditions.push("soar");
  if (thermalXC) conditions.push("xc");
  if (conditions.length === 0) conditions.push("sledder");

  return finish(fields(unpenalized, conditions), reasons, defaults);
}

/**
 * Second pass over one model's hours for one launch: caps the hours within
 * `stormLookaheadHours` before a convective no-go at flyable ("storms forecast by HH:00").
 * A convective no-go has a precipitation no-go and max(CAPE h, CAPE h+1) at or above
 * `stormCapeJkg`. `results` are the evaluations of `hours`, matched by time; hour h+k is the result
 * at `time + k * HOUR_MS`, so a gap in the series is simply a missing hour. No-go and no-data hours
 * are left unchanged. Returns a new array in the input order; the input is not mutated.
 */
export function applyStormLookahead(
  results: readonly HourResult[],
  hours: readonly ModelHour[],
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): HourResult[] {
  const resultAt = byTime(results);
  const hourAt = byTime(hours);
  const convective = (t: number): boolean => {
    const r = resultAt.get(t);
    if (r === undefined || !r.reasons.some((x) => x.kind === "precipitation")) return false;
    const cape = definedMax(hourAt.get(t)?.capeJkg, hourAt.get(t + HOUR_MS)?.capeJkg);
    return cape !== undefined && cape >= defaults.stormCapeJkg;
  };

  return results.map((r) => {
    if (r.call === "noGo" || r.call === "noData") return r;
    if (r.reasons.some((x) => x.kind === "stormsComing")) return r;
    for (let k = 1; k <= defaults.stormLookaheadHours; k++) {
      const t = r.time + k * HOUR_MS;
      if (!convective(t)) continue;
      const added = reason("stormsComing", `storms forecast by ${formatDenverTime(t)}`);
      return finish(r, [...r.reasons, added], defaults);
    }
    return r;
  });
}
