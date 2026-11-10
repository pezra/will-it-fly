import type { DaylightDay, LaunchForecast, ModelHour, NeighborWind } from "../forecast/models";
import { SCORING_DEFAULTS } from "../scoring/defaults";
import type { ScoringDefaults } from "../scoring/defaults";
import { CHECK_MODEL, applyStormLookahead, evaluateHour } from "../scoring/hourEvaluator";
import type { HourContext, HourResult, ModelName } from "../scoring/hourEvaluator";
import { checkCovers } from "../scoring/modelAgreement";
import { daylightDayFor, daylightHours, findBestWindow } from "../scoring/windowFinder";
import type { Launch, Site } from "../sites/site";
import { HOUR_MS, byTime } from "../time";
import type { DayKey } from "../time";
import type { DaylightRow, LaunchEvaluation } from "./types";

/** Evaluates the hours in time order, then runs the storm look-ahead (which matches by time). */
function evaluateSeries(
  hours: readonly ModelHour[],
  evaluate: (hour: ModelHour) => HourResult,
  defaults: ScoringDefaults,
): HourResult[] {
  const sorted = [...byTime(hours).values()].sort((a, b) => a.time - b.time);
  return applyStormLookahead(sorted.map(evaluate), sorted, defaults);
}

/**
 * Evaluates every hour of both models for one launch. Every series is aligned by `time`, never by
 * index, so a gap in one model leaves the other's hour h paired with the hour that has the same
 * time (or none). Only the primary model sees the other model's hours. The storm look-ahead runs
 * per model, by time.
 */
export function evaluateForecast(
  site: Site,
  launch: Launch,
  forecast: LaunchForecast,
  primary: ModelName = "ecmwf",
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): Record<ModelName, HourResult[]> {
  return evaluateForecastIndexed(site, launch, forecast, primary, defaults).results;
}

interface Evaluated {
  results: Record<ModelName, HourResult[]>;
  /** Both models' input hours by time, for the caller to reuse. */
  hours: Record<ModelName, Map<number, ModelHour>>;
}

/** `evaluateForecast` plus the by-time maps of both models' input hours. */
function evaluateForecastIndexed(
  site: Site,
  launch: Launch,
  forecast: LaunchForecast,
  primary: ModelName,
  defaults: ScoringDefaults,
): Evaluated {
  const hours: Record<ModelName, Map<number, ModelHour>> = {
    ecmwf: byTime(forecast.ecmwf),
    rrfs: byTime(forecast.rrfs),
  };
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
    const t = hour.time;
    const other = hours[CHECK_MODEL[model]];
    return {
      model,
      hour,
      next: hours[model].get(t + HOUR_MS),
      other: model === primary ? { hour: other.get(t), next: other.get(t + HOUR_MS) } : undefined,
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

  function run(model: ModelName, series: readonly ModelHour[]): HourResult[] {
    return evaluateSeries(series, (h) => evaluateHour(context(model, h), defaults), defaults);
  }

  return { results: { ecmwf: run("ecmwf", forecast.ecmwf), rrfs: run("rrfs", forecast.rrfs) }, hours };
}

/**
 * True when RRFS covers enough of the day's window hours to be the primary model. The window hours
 * are the times either model has inside `daylightHours`. RRFS covers one when it has a result there
 * that isn't no data. With no window hours left, RRFS stands.
 */
function rrfsCoversDay(
  results: Record<ModelName, HourResult[]>,
  day: DaylightDay,
  now: number,
  defaults: ScoringDefaults,
): boolean {
  const windowHours = new Set(
    daylightHours([...results.ecmwf, ...results.rrfs], day, now).map((r) => r.time),
  );
  if (windowHours.size === 0) return true;
  const covered = daylightHours(results.rrfs, day, now).filter(checkCovers).length;
  return covered / windowHours.size >= defaults.rrfsPrimaryMinDaylightShare;
}

/** The daylight rows and best window, with `primary` deciding and the other model as the check. */
function launchEvaluation(
  launch: Launch,
  primary: ModelName,
  fellBack: boolean,
  { results, hours }: Evaluated,
  day: DaylightDay,
  now: number,
  defaults: ScoringDefaults,
): LaunchEvaluation {
  const check = CHECK_MODEL[primary];
  const primaryResults = daylightHours(results[primary], day, now);
  const checkByTime = byTime(results[check]);
  const daylight = primaryResults.flatMap((result): DaylightRow[] => {
    const hour = hours[primary].get(result.time);
    if (hour === undefined) return [];
    const checkResult = checkByTime.get(result.time);
    const checkHour = hours[check].get(result.time);
    return [
      {
        time: result.time,
        primary: { result, hour },
        check:
          checkResult === undefined || checkHour === undefined
            ? undefined
            : { result: checkResult, hour: checkHour },
      },
    ];
  });
  return {
    launch,
    model: primary,
    fellBack,
    daylight,
    window: findBestWindow(primaryResults, checkByTime, defaults),
  };
}

/**
 * Evaluates one launch with `model` as the primary model and finds its best window for the day.
 * With RRFS asked for, a launch whose RRFS covers less than `rrfsPrimaryMinDaylightShare` of the
 * day's window hours uses ECMWF instead, and is marked `fellBack`.
 */
export function evaluateLaunch(
  site: Site,
  launch: Launch,
  forecast: LaunchForecast,
  day: DayKey,
  now: number,
  model: ModelName,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): LaunchEvaluation {
  const daylightDay = daylightDayFor(forecast.days, day);
  if (daylightDay === undefined) {
    return { launch, model, fellBack: false, daylight: [], window: undefined };
  }
  const evaluated = evaluateForecastIndexed(site, launch, forecast, model, defaults);
  // The cross-check reason is only a caution, so it never makes an hour no data: the requested
  // model's own run measures RRFS coverage exactly. The fallback runs again so that ECMWF sees RRFS.
  if (model === "rrfs" && !rrfsCoversDay(evaluated.results, daylightDay, now, defaults)) {
    const ecmwf = evaluateForecastIndexed(site, launch, forecast, "ecmwf", defaults);
    return launchEvaluation(launch, "ecmwf", true, ecmwf, daylightDay, now, defaults);
  }
  return launchEvaluation(launch, model, false, evaluated, daylightDay, now, defaults);
}
