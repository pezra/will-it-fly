import type { LaunchForecast, ModelHour, NeighborWind } from "../forecast/models";
import { SCORING_DEFAULTS } from "../scoring/defaults";
import type { ScoringDefaults } from "../scoring/defaults";
import { applyStormLookahead, evaluateHour } from "../scoring/hourEvaluator";
import type { HourContext, HourResult, ModelName } from "../scoring/hourEvaluator";
import { daylightDayFor, daylightHours, findBestWindow } from "../scoring/windowFinder";
import type { TargetDay } from "../scoring/windowFinder";
import type { Launch, Site } from "../sites/site";
import { HOUR_MS, byTime } from "../time";
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
  const day = daylightDayFor(forecast.days, which, now);
  if (day === undefined) return { launch, daylight: [], window: undefined };
  const { ecmwf, rrfs } = evaluateForecast(site, launch, forecast, defaults);
  const results = daylightHours(ecmwf, day, now);
  const rrfsByTime = byTime(rrfs);
  const ecmwfHours = byTime(forecast.ecmwf);
  const rrfsHours = byTime(forecast.rrfs);
  const daylight = results.flatMap((result): DaylightRow[] => {
    const ecmwfHour = ecmwfHours.get(result.time);
    if (ecmwfHour === undefined) return [];
    return [
      {
        time: result.time,
        ecmwf: result,
        ecmwfHour,
        rrfs: rrfsByTime.get(result.time),
        rrfsHour: rrfsHours.get(result.time),
      },
    ];
  });
  return { launch, daylight, window: findBestWindow(results, rrfsByTime, defaults) };
}
