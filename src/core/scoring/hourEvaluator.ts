import type { ModelHour, NeighborWind } from "../forecast/models";
import { NEIGHBOR_DISTANCE_M } from "../forecast/openMeteoClient";
import { angularDifference, arcsContain, normalizedDegrees } from "../sites/degreeArc";
import type { DegreeArc, Launch, Site, WindLimits } from "../sites/site";
import { DEFAULT_WIND_LIMITS, elevationM } from "../sites/site";
import { formatDenverTime } from "../time";
import { METERS_PER_FOOT } from "../units";
import { SCORING_DEFAULTS, cloudBaseBonusM, lowCloudBaseMarginalM } from "./defaults";
import type { ScoringDefaults } from "./defaults";
import {
  aloftWind,
  cloudBaseAboveLaunchM,
  launchWind,
  thermalIndex,
  topOfLiftM,
} from "./derived";
import type { Wind } from "./derived";

export type ModelName = "ecmwf" | "rrfs";

export type HourCall = "flyable" | "marginal" | "noGo" | "noData";

export type Severity = "info" | "marginal" | "noGo";

/**
 * Every reason kind, declared roughly most-severe first: no-go kinds, then marginal, then
 * info ("n/a"). Ties in reason counts are broken by this order.
 */
export const REASON_KIND_ORDER = [
  // No-go
  "noData",
  "precipitation",
  "gusts",
  "windTooStrong",
  "windTooWeak",
  "wrongDirection",
  "overTheBack",
  "strongAloft",
  "neighborWindStrong",
  // Marginal
  "stormsComing",
  "rrfsSeesStorms",
  "overdevelopment",
  "aloftWind",
  "nearMaxWind",
  "gustFactor",
  "lowCloud",
  "neighborWind",
  "preThermal",
  "directionNotIdeal",
  "notCurated",
  // Info: a rule or score factor skipped for missing data
  "gustUnavailable",
  "capeUnavailable",
  "aloftWindUnavailable",
  "cloudBaseUnavailable",
  "lowCloudCoverUnavailable",
  "blhUnavailable",
  "thermalIndexUnavailable",
  "neighborUnavailable",
] as const;

export type ReasonKind = (typeof REASON_KIND_ORDER)[number];

/** Each kind has exactly one severity. */
export const REASON_SEVERITY: Readonly<Record<ReasonKind, Severity>> = Object.freeze({
  noData: "noGo",
  precipitation: "noGo",
  gusts: "noGo",
  windTooStrong: "noGo",
  windTooWeak: "noGo",
  wrongDirection: "noGo",
  overTheBack: "noGo",
  strongAloft: "noGo",
  neighborWindStrong: "noGo",
  stormsComing: "marginal",
  rrfsSeesStorms: "marginal",
  overdevelopment: "marginal",
  aloftWind: "marginal",
  nearMaxWind: "marginal",
  gustFactor: "marginal",
  lowCloud: "marginal",
  neighborWind: "marginal",
  preThermal: "marginal",
  directionNotIdeal: "marginal",
  notCurated: "marginal",
  gustUnavailable: "info",
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
   * Base score plus bonuses, before marginal penalties and clamping. Kept so the storm look-ahead
   * can add a reason and recompute the score exactly.
   */
  unpenalizedScore: number;
}

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
  /** For ECMWF evaluation, the RRFS hour and its next hour. Undefined for RRFS evaluation. */
  other?: { hour: ModelHour | undefined; next: ModelHour | undefined } | undefined;
  /** The neighbor request's center 10 m wind at h, per model (not the launch request's wind). */
  neighborCenter: NeighborSample;
  /** Each neighbor's 10 m wind at h, per model. */
  neighbors: readonly NeighborPointSample[];
  launch: Launch;
  site: Site;
}

const MODEL_LABEL: Readonly<Record<ModelName, string>> = { ecmwf: "ECMWF", rrfs: "RRFS" };
const METERS_PER_MILE = 1609.344;
const COMPASS_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

function compass(deg: number): string {
  return COMPASS_16[Math.round(normalizedDegrees(deg) / 22.5) % 16] ?? "N";
}

function mph(speed: number): string {
  return `${Math.round(speed)} mph`;
}

function windText(w: Wind): string {
  return `${compass(w.dirDeg)} ${mph(w.speedMph)}`;
}

function reason(kind: ReasonKind, text: string): Reason {
  return { kind, severity: REASON_SEVERITY[kind], text };
}

function definedMax(...values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}

function sortedReasons(reasons: Reason[]): Reason[] {
  return [...reasons].sort(
    (a, b) => REASON_KIND_ORDER.indexOf(a.kind) - REASON_KIND_ORDER.indexOf(b.kind),
  );
}

/** The call and score from a reason list and the unpenalized score. */
function finish(
  time: number,
  reasons: Reason[],
  unpenalizedScore: number,
  wind: Wind | undefined,
  defaults: ScoringDefaults,
): HourResult {
  const sorted = sortedReasons(reasons);
  const has = (s: Severity) => sorted.some((r) => r.severity === s);
  let call: HourCall;
  if (sorted.some((r) => r.kind === "noData")) call = "noData";
  else if (has("noGo")) call = "noGo";
  else if (has("marginal")) call = "marginal";
  else call = "flyable";

  let score = defaults.minScore;
  if (call === "flyable" || call === "marginal") {
    let penalties = 0;
    for (const r of sorted) {
      if (r.severity !== "marginal") continue;
      // The gust-factor penalty replaces the generic one for that reason.
      penalties += r.kind === "gustFactor" ? defaults.gustFactorPenalty : defaults.marginalReasonPenalty;
    }
    score = Math.min(defaults.maxScore, Math.max(defaults.minScore, unpenalizedScore - penalties));
  }
  return { time, call, score, reasons: sorted, launchWind: wind, unpenalizedScore };
}

/** Launch limits override the site limits as a whole. */
function effectiveLimits(launch: Launch, site: Site): WindLimits {
  return launch.limits ?? site.limits;
}

/**
 * The ideal arcs with the fallback applied: an empty list means anywhere in `ok`, and a
 * zero-width arc (from === to) means that heading plus or minus the half-width.
 */
function effectiveIdealArcs(launch: Launch, defaults: ScoringDefaults): DegreeArc[] {
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

/**
 * The neighbor check: one model on both sides (center 10 m vs neighbor 10 m). RRFS when its
 * center and at least one neighbor are present, else ECMWF on the same test, else "n/a".
 * Returns at most one reason, naming the worst neighbor.
 */
function neighborReason(ctx: HourContext, defaults: ScoringDefaults): Reason | undefined {
  for (const model of ["rrfs", "ecmwf"] as const) {
    const center = toWind(ctx.neighborCenter[model]);
    if (center === undefined) continue;
    const points = ctx.neighbors.flatMap((p) => {
      const wind = toWind(p[model]);
      return wind === undefined ? [] : [{ bearingDeg: p.bearingDeg, wind }];
    });
    if (points.length === 0) continue;

    let worst: { kind: ReasonKind; diff: number; bearingDeg: number; wind: Wind } | undefined;
    for (const { bearingDeg, wind } of points) {
      if (center.speedMph < defaults.neighborMinWindMph || wind.speedMph < defaults.neighborMinWindMph) {
        continue;
      }
      const diff = angularDifference(center.dirDeg, wind.dirDeg);
      if (diff <= defaults.neighborMarginalDiffDeg) continue;
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
    const miles = Math.round(NEIGHBOR_DISTANCE_M / METERS_PER_MILE);
    return reason(
      worst.kind,
      `inconsistent wind nearby: ${miles} mi ${compass(worst.bearingDeg)}: ${windText(worst.wind)} (${MODEL_LABEL[model]})`,
    );
  }
  return reason("neighborUnavailable", "wind nearby: n/a");
}

/** True if this hour has a precipitation or gust no-go by max(h, h+1). */
function precipOrGustNoGo(
  hour: ModelHour,
  next: ModelHour | undefined,
  defaults: ScoringDefaults,
): boolean {
  const precip = definedMax(hour.precipMm, next?.precipMm);
  const gust = definedMax(hour.gustMph, next?.gustMph);
  return (
    (precip !== undefined && precip >= defaults.precipNoGoMm) ||
    (gust !== undefined && gust >= defaults.gustNoGoMph)
  );
}

/** The per-hour call, score and reasons for one launch and one model. */
export function evaluateHour(ctx: HourContext, defaults: ScoringDefaults = SCORING_DEFAULTS): HourResult {
  const { hour, next, launch } = ctx;
  const elev = elevationM(launch);
  const wind = launchWind(hour, elev);

  // Core fields: the launch wind (10 m speed and direction) and precipitation at h.
  const missing: string[] = [];
  if (wind === undefined) missing.push("wind");
  if (hour.precipMm === undefined) missing.push("precipitation");
  if (wind === undefined || missing.length > 0) {
    return finish(hour.time, [reason("noData", `no data: ${missing.join(", ")}`)], 0, wind, defaults);
  }

  const reasons: Reason[] = [];
  const limits = effectiveLimits(launch, ctx.site);
  const { ok } = launch.directions;
  const curated = ok.length > 0;
  const directional = wind.speedMph >= defaults.variableDirectionBelowMph;

  // Precipitation and gusts: the preceding-hour values, so max(h, h+1).
  const precip = definedMax(hour.precipMm, next?.precipMm) ?? 0;
  if (precip >= defaults.precipNoGoMm) {
    reasons.push(reason("precipitation", `rain ${precip.toFixed(1)} mm`));
  }
  const gust = definedMax(hour.gustMph, next?.gustMph);
  if (gust === undefined) {
    reasons.push(reason("gustUnavailable", "gusts: n/a"));
  } else {
    if (gust >= defaults.gustNoGoMph) reasons.push(reason("gusts", `gusts ${mph(gust)}`));
    // Both sides from this model's 10 m wind, never the interpolated launch wind.
    const surface = hour.windMph ?? 0;
    const factor = Math.max(0, gust - surface);
    const limit = limits.gustFactorMph ?? DEFAULT_WIND_LIMITS.gustFactorMph ?? 0;
    if (factor > limit) reasons.push(reason("gustFactor", `gust factor ${mph(factor)}`));
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

  // Launch wind direction. Below the variable threshold, direction is ignored.
  let inIdeal = false;
  if (!curated) {
    reasons.push(reason("notCurated", "launch direction not curated"));
  } else if (directional) {
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
    if (!strong && !overTheBack && aloft.speedMph >= defaults.aloftMarginalMph) {
      reasons.push(reason("aloftWind", `wind aloft ${windText(aloft)}`));
    }
  }

  // CAPE (instantaneous, hour h).
  if (hour.capeJkg === undefined) {
    reasons.push(reason("capeUnavailable", "CAPE: n/a"));
  } else if (hour.capeJkg >= defaults.capeMarginalJkg) {
    reasons.push(reason("overdevelopment", `overdevelopment risk (CAPE ${Math.round(hour.capeJkg)} J/kg)`));
  }

  // Low cloud.
  const cloudBase = cloudBaseAboveLaunchM(hour, defaults);
  const lowCloud: string[] = [];
  if (cloudBase === undefined) {
    reasons.push(reason("cloudBaseUnavailable", "cloud base: n/a"));
  } else if (cloudBase < lowCloudBaseMarginalM(defaults)) {
    lowCloud.push(`base ≈${Math.round(cloudBase / METERS_PER_FOOT)} ft above launch`);
  }
  if (hour.lowCloudPct === undefined) {
    reasons.push(reason("lowCloudCoverUnavailable", "low cloud cover: n/a"));
  } else if (hour.lowCloudPct >= defaults.lowCloudCoverMarginalPct) {
    lowCloud.push(`${Math.round(hour.lowCloudPct)}% low cloud`);
  }
  if (lowCloud.length > 0) reasons.push(reason("lowCloud", `low cloud: ${lowCloud.join(", ")}`));

  // Wind nearby.
  const neighbor = neighborReason(ctx, defaults);
  if (neighbor !== undefined) reasons.push(neighbor);

  // Pre-thermal: BLH low and TI positive. With one missing, the other decides.
  const blh = hour.blhM;
  const ti = thermalIndex(hour, elev, defaults);
  if (blh === undefined) reasons.push(reason("blhUnavailable", "BLH: n/a"));
  if (ti === undefined) reasons.push(reason("thermalIndexUnavailable", "thermal index: n/a"));
  if (blh !== undefined || ti !== undefined) {
    const lowBLH = blh === undefined || blh < defaults.preThermalBLHBelowM;
    const stableTI = ti === undefined || ti > defaults.preThermalTIAboveC;
    if (lowBLH && stableTI) reasons.push(reason("preThermal", "pre-thermal: sled ride"));
  }

  // RRFS sees storms (ECMWF evaluation only).
  if (ctx.model === "ecmwf" && ctx.other?.hour !== undefined) {
    if (precipOrGustNoGo(ctx.other.hour, ctx.other.next, defaults)) {
      reasons.push(reason("rrfsSeesStorms", "RRFS sees storms"));
    }
  }

  // Score bonuses.
  let unpenalized = defaults.baseScore + windBonus(wind.speedMph, limits, defaults);
  if (inIdeal) unpenalized += defaults.idealDirectionBonus;
  if (ti !== undefined) {
    if (ti <= defaults.thermalIndexStrongMaxC) unpenalized += defaults.thermalIndexStrongBonus;
    else if (ti <= defaults.thermalIndexModerateMaxC) unpenalized += defaults.thermalIndexModerateBonus;
  }
  if (blh !== undefined && blh >= defaults.blhBonusMinM) unpenalized += defaults.blhBonus;
  if (cloudBase !== undefined && cloudBase >= cloudBaseBonusM(defaults)) {
    unpenalized += defaults.cloudBaseBonus;
  }

  return finish(hour.time, reasons, unpenalized, wind, defaults);
}

/**
 * Second pass over one model's hours for one launch: caps the hours within
 * `stormLookaheadHours` before a convective no-go at marginal ("storms forecast by HH:00").
 * A convective no-go has a precipitation or gust no-go and max(CAPE h, CAPE h+1) at or above
 * `stormCapeJkg`. `results[i]` must be the evaluation of `hours[i]`, with hours contiguous.
 * No-go and no-data hours are left unchanged. Returns a new array; the input is not mutated.
 */
export function applyStormLookahead(
  results: readonly HourResult[],
  hours: readonly ModelHour[],
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): HourResult[] {
  const convective = results.map((r, j) => {
    if (!r.reasons.some((x) => x.kind === "precipitation" || x.kind === "gusts")) return false;
    const cape = definedMax(hours[j]?.capeJkg, hours[j + 1]?.capeJkg);
    return cape !== undefined && cape >= defaults.stormCapeJkg;
  });

  return results.map((r, i) => {
    if (r.call === "noGo" || r.call === "noData") return r;
    if (r.reasons.some((x) => x.kind === "stormsComing")) return r;
    let storm: number | undefined;
    for (let j = i + 1; j <= i + defaults.stormLookaheadHours && j < results.length; j++) {
      if (convective[j]) {
        storm = j;
        break;
      }
    }
    const stormResult = storm === undefined ? undefined : results[storm];
    if (stormResult === undefined) return r;
    const added = reason("stormsComing", `storms forecast by ${formatDenverTime(stormResult.time)}`);
    return finish(r.time, [...r.reasons, added], r.unpenalizedScore, r.launchWind, defaults);
  });
}
