import type { DaylightDay } from "../forecast/models";
import { HOUR_MS, addDays, denverDayKey, formatDenverTime } from "../time";
import type { DayKey } from "../time";
import { SCORING_DEFAULTS, runLengthWeight } from "./defaults";
import type { ScoringDefaults } from "./defaults";
import { sortedReasons } from "./hourEvaluator";
import type { HourCondition, HourResult, Reason } from "./hourEvaluator";
import { confidenceWeight, runConfidence } from "./modelAgreement";
import type { Confidence } from "./modelAgreement";

export type { Confidence } from "./modelAgreement";

export type { DayKey } from "../time";

export interface FlyingWindow {
  /** Start of the first hour (epoch ms). */
  start: number;
  /** Start of the last hour plus one hour (epoch ms). */
  end: number;
  /** The run's primary-model hour results, in time order. */
  hours: HourResult[];
  /** Mean hour score x run-length weight x confidence weight. */
  score: number;
  confidence: Confidence;
  /** The run's warning reasons, one per kind (the first occurrence), for the summary. */
  warnings: Reason[];
  /** Soar and XC if any hour has them, else sledder. */
  conditions: HourCondition[];
  /** The run's caution reasons, one per kind (the first occurrence), most severe kind first. */
  cautions: Reason[];
}

/** Today's Denver day key, or tomorrow's when `now` is after today's sunset. */
export function targetDay(now: number, sunsetToday: number): DayKey {
  const today = denverDayKey(now);
  return now > sunsetToday ? addDays(today, 1) : today;
}

/** The daylight entry for a day, matched by the Denver day key of its sunrise. */
export function daylightDayFor(days: readonly DaylightDay[], key: DayKey): DaylightDay | undefined {
  return days.find((d) => denverDayKey(d.sunrise) === key);
}

/**
 * Results for the day's daylight hours, sorted by time. An hour counts when its start is >= sunrise
 * and < sunset, and it hasn't finished before `now` (so today starts at the hour containing `now`).
 */
export function daylightHours<T extends { time: number }>(
  results: readonly T[],
  day: DaylightDay,
  now: number,
): T[] {
  return results
    .filter((r) => r.time >= day.sunrise && r.time < day.sunset && r.time + HOUR_MS > now)
    .sort((a, b) => a.time - b.time);
}

/** "HH:00–HH:00" in Denver time. */
export function windowLabel(w: Pick<FlyingWindow, "start" | "end">): string {
  return `${formatDenverTime(w.start)}–${formatDenverTime(w.end)}`;
}

function buildWindow(
  run: HourResult[],
  checkByTime: ReadonlyMap<number, HourResult>,
  defaults: ScoringDefaults,
): FlyingWindow {
  const confidence = runConfidence(run, checkByTime, defaults);
  const mean = run.reduce((sum, h) => sum + h.score, 0) / run.length;
  const first = run[0];
  const last = run[run.length - 1];
  if (first === undefined || last === undefined) throw new Error("empty run");
  return {
    start: first.time,
    end: last.time + HOUR_MS,
    hours: run,
    score: mean * runLengthWeight(run.length, defaults) * confidenceWeight(confidence, defaults),
    confidence,
    warnings: firstPerKind(run, "warning"),
    conditions: windowConditions(run),
    cautions: sortedReasons(firstPerKind(run, "caution")),
  };
}

function windowConditions(run: readonly HourResult[]): HourCondition[] {
  const found = (["soar", "xc"] as const).filter((c) => run.some((h) => h.conditions.includes(c)));
  return found.length > 0 ? found : ["sledder"];
}

/** The first reason of each kind with the given severity across the run, in first-seen order. */
function firstPerKind(run: readonly HourResult[], severity: Reason["severity"]): Reason[] {
  const byKind = new Map<Reason["kind"], Reason>();
  for (const h of run) {
    for (const r of h.reasons) {
      if (r.severity === severity && !byKind.has(r.kind)) byKind.set(r.kind, r);
    }
  }
  return [...byKind.values()];
}

/**
 * The highest-scoring run of consecutive good or flyable primary-model hours, from `daylight` (the
 * target day's primary-model results from `daylightHours`, in time order). A no-go, no-data or
 * missing hour breaks a run. Ties go to the earlier run. `checkByTime` is the check model's results,
 * for the window's confidence.
 */
export function findBestWindow(
  daylight: readonly HourResult[],
  checkByTime: ReadonlyMap<number, HourResult>,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): FlyingWindow | undefined {
  let best: FlyingWindow | undefined;
  let run: HourResult[] = [];

  const close = (): void => {
    if (run.length > 0) {
      const w = buildWindow(run, checkByTime, defaults);
      if (best === undefined || w.score > best.score) best = w;
    }
    run = [];
  };

  for (const h of daylight) {
    const prev = run[run.length - 1];
    if (prev !== undefined && h.time !== prev.time + HOUR_MS) close();
    if (h.call === "noGo" || h.call === "noData") close();
    else run.push(h);
  }
  close();
  return best;
}
