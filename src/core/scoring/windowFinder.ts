import type { DaylightDay } from "../forecast/models";
import { HOUR_MS, denverDayKey, formatDenverTime } from "../time";
import { SCORING_DEFAULTS, runLengthWeight } from "./defaults";
import type { ScoringDefaults } from "./defaults";
import type { HourResult } from "./hourEvaluator";
import { confidenceWeight, runConfidence } from "./modelAgreement";
import type { Confidence } from "./modelAgreement";

export type { Confidence } from "./modelAgreement";

export type TargetDay = "today" | "tomorrow";

export interface FlyingWindow {
  /** Start of the first hour (epoch ms). */
  start: number;
  /** Start of the last hour plus one hour (epoch ms). */
  end: number;
  /** The run's ECMWF hour results, in time order. */
  hours: HourResult[];
  /** Mean hour score x run-length weight x confidence weight. */
  score: number;
  confidence: Confidence;
}

/** Today, unless `now` is after today's sunset. */
export function targetDay(now: number, sunsetToday: number): TargetDay {
  return now > sunsetToday ? "tomorrow" : "today";
}

/**
 * The daylight entry for the target day, matched by Denver day key of its sunrise. "Tomorrow" is the
 * earliest day after today's key. Undefined when the response doesn't cover that day.
 */
export function daylightDayFor(
  days: readonly DaylightDay[],
  which: TargetDay,
  now: number,
): DaylightDay | undefined {
  const todayKey = denverDayKey(now);
  if (which === "today") return days.find((d) => denverDayKey(d.sunrise) === todayKey);
  let best: DaylightDay | undefined;
  let bestKey = "";
  for (const d of days) {
    const key = denverDayKey(d.sunrise);
    if (key > todayKey && (best === undefined || key < bestKey)) {
      best = d;
      bestKey = key;
    }
  }
  return best;
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
  rrfsByTime: ReadonlyMap<number, HourResult>,
  defaults: ScoringDefaults,
): FlyingWindow {
  const confidence = runConfidence(run, rrfsByTime, defaults);
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
  };
}

/**
 * The highest-scoring run of consecutive non-no-go ECMWF daylight hours with at least one flyable
 * hour. A no-go, no-data or missing hour breaks a run. Ties go to the earlier run.
 */
export function findBestWindow(
  ecmwf: readonly HourResult[],
  rrfs: readonly HourResult[],
  day: DaylightDay,
  now: number,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): FlyingWindow | undefined {
  const rrfsByTime = new Map(rrfs.map((r) => [r.time, r] as const));
  let best: FlyingWindow | undefined;
  let run: HourResult[] = [];

  const close = (): void => {
    if (run.some((h) => h.call === "flyable")) {
      const w = buildWindow(run, rrfsByTime, defaults);
      if (best === undefined || w.score > best.score) best = w;
    }
    run = [];
  };

  for (const h of daylightHours(ecmwf, day, now)) {
    const prev = run[run.length - 1];
    if (prev !== undefined && h.time !== prev.time + HOUR_MS) close();
    if (h.call === "noGo" || h.call === "noData") close();
    else run.push(h);
  }
  close();
  return best;
}
