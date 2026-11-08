import type { LaunchForecast, ModelHour, NeighborWind } from "../forecast/models";
import { SCORING_DEFAULTS } from "../scoring/defaults";
import type { ScoringDefaults } from "../scoring/defaults";
import { applyStormLookahead, evaluateHour } from "../scoring/hourEvaluator";
import type { HourContext, HourResult, ModelName } from "../scoring/hourEvaluator";
import { daylightDayFor, daylightHours, findBestWindow } from "../scoring/windowFinder";
import type { TargetDay } from "../scoring/windowFinder";
import type { Launch, Site } from "../sites/site";
import { HOUR_MS } from "../time";
import type { LaunchEvaluation } from "./types";

function byTime<T extends { time: number }>(items: readonly T[]): Map<number, T> {
  return new Map(items.map((item) => [item.time, item] as const));
}

/**
 * Evaluates the hours and runs the storm look-ahead, which assumes `results[i + 1]` is the next
 * hour. Gaps are therefore filled with no-data placeholders for the look-ahead, and dropped after.
 */
function evaluateSeries(
  hours: readonly ModelHour[],
  evaluate: (hour: ModelHour) => HourResult,
  defaults: ScoringDefaults,
): HourResult[] {
  const byHour = byTime([...hours]);
  const first = Math.min(...hours.map((h) => h.time));
  const last = Math.max(...hours.map((h) => h.time));
  const padded: ModelHour[] = [];
  const results: HourResult[] = [];
  for (let time = first; time <= last; time += HOUR_MS) {
    const hour = byHour.get(time);
    padded.push(hour ?? { time, levels: {} });
    results.push(
      hour === undefined
        ? { time, call: "noData", score: defaults.minScore, reasons: [], unpenalizedScore: 0 }
        : evaluate(hour),
    );
  }
  const looked = applyStormLookahead(results, padded, defaults);
  return looked.filter((r) => byHour.has(r.time));
}

/**
 * Evaluates every hour of both models for one launch. Every series is aligned by `time`, never by
 * index, so an RRFS gap leaves ECMWF hour h paired with the RRFS hour that has the same time (or
 * none). The storm look-ahead runs per model, by time.
 */
export function evaluateForecast(
  site: Site,
  launch: Launch,
  forecast: LaunchForecast,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): { ecmwf: HourResult[]; rrfs: HourResult[] } {
  const ecmwfByTime = byTime(forecast.ecmwf);
  const rrfsByTime = byTime(forecast.rrfs);
  const centers: Record<ModelName, Map<number, NeighborWind>> = {
    ecmwf: byTime(forecast.neighborCenter.ecmwf),
    rrfs: byTime(forecast.neighborCenter.rrfs),
  };
  const neighbors = forecast.neighbors.map((n) => ({
    bearingDeg: n.bearingDeg,
    ecmwf: byTime(n.ecmwf),
    rrfs: byTime(n.rrfs),
  }));

  function context(model: ModelName, hour: ModelHour): HourContext {
    const own = model === "ecmwf" ? ecmwfByTime : rrfsByTime;
    const t = hour.time;
    return {
      model,
      hour,
      next: own.get(t + HOUR_MS),
      other:
        model === "ecmwf"
          ? { hour: rrfsByTime.get(t), next: rrfsByTime.get(t + HOUR_MS) }
          : undefined,
      neighborCenter: { ecmwf: centers.ecmwf.get(t), rrfs: centers.rrfs.get(t) },
      neighbors: neighbors.map((n) => ({
        bearingDeg: n.bearingDeg,
        ecmwf: n.ecmwf.get(t),
        rrfs: n.rrfs.get(t),
      })),
      launch,
      site,
    };
  }

  function run(model: ModelName, hours: readonly ModelHour[]): HourResult[] {
    if (hours.length === 0) return [];
    return evaluateSeries(hours, (h) => evaluateHour(context(model, h), defaults), defaults);
  }

  return { ecmwf: run("ecmwf", forecast.ecmwf), rrfs: run("rrfs", forecast.rrfs) };
}

/** Evaluates one launch and finds its best window for the target day. */
export function evaluateLaunch(
  site: Site,
  launch: Launch,
  forecast: LaunchForecast,
  which: TargetDay,
  now: number,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): LaunchEvaluation {
  const { ecmwf, rrfs } = evaluateForecast(site, launch, forecast, defaults);
  const day = daylightDayFor(forecast.days, which, now);
  return {
    launch,
    ecmwfHours: forecast.ecmwf,
    rrfsHours: forecast.rrfs,
    ecmwf,
    rrfs,
    daylight: day === undefined ? [] : daylightHours(ecmwf, day, now),
    window: day === undefined ? undefined : findBestWindow(ecmwf, rrfs, day, now, defaults),
  };
}
