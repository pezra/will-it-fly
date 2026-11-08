import type { CachedForecast, ForecastCache } from "../forecast/forecastCache";
import type { LaunchForecast } from "../forecast/models";
import { fetchForecasts, OpenMeteoError, parseForecasts } from "../forecast/openMeteoClient";
import type { Transport } from "../forecast/openMeteoClient";
import { SCORING_DEFAULTS } from "../scoring/defaults";
import type { ScoringDefaults } from "../scoring/defaults";
import { daylightDayFor, targetDay } from "../scoring/windowFinder";
import type { SiteProvider } from "../sites/siteProvider";
import type { Launch } from "../sites/site";
import { addDays, denverDayKey, formatDayKey } from "../time";
import type { DayKey } from "../time";
import { evaluateLaunch } from "./evaluateLaunch";
import { rankSites, recommendSite } from "./ranker";
import type { RecommendationResult } from "./types";

export interface RecommendationRequest {
  forceRefresh: boolean;
  /**
   * The Denver day to evaluate. Undefined means the default: today, or tomorrow after today's sunset.
   * Today and tomorrow come from the main forecast; a later day is fetched on its own.
   */
  day?: DayKey | undefined;
}

export interface RecommendationDeps {
  siteProvider: SiteProvider;
  transport: Transport;
  baseURL?: string | undefined;
  /** Holds the main (today and tomorrow) forecast. */
  cache: ForecastCache;
  /** Holds the last single-day forecast fetched for a day after tomorrow. */
  dayCache: ForecastCache;
  now: () => number;
  defaults?: ScoringDefaults | undefined;
}

/** How many days after today can be asked for. ECMWF runs about 15 days out. */
export const MAX_DAYS_AHEAD = 14;

/** Thrown for a requested day before today or more than `MAX_DAYS_AHEAD` days after it. */
export class DayOutOfRangeError extends Error {
  constructor(day: DayKey, today: DayKey) {
    super(
      `There's no forecast for ${formatDayKey(day)}. Pick a day from ${formatDayKey(today)} to ${formatDayKey(addDays(today, MAX_DAYS_AHEAD))}.`,
    );
    this.name = "DayOutOfRangeError";
  }
}

/** The default day, from the sunset of the first forecast that covers today (it decides for every site). */
function defaultDay(forecasts: readonly LaunchForecast[], now: number): DayKey | undefined {
  const todayKey = denverDayKey(now);
  for (const { days } of forecasts) {
    const today = daylightDayFor(days, todayKey);
    if (today !== undefined) return targetDay(now, today.sunset);
  }
  return undefined;
}

/**
 * The default day (see `defaultDay`), when some forecast also covers it. Undefined when no forecast
 * covers both today and the default day.
 */
export function resolveTargetDay(
  forecasts: readonly LaunchForecast[],
  now: number,
): DayKey | undefined {
  const todayKey = denverDayKey(now);
  for (const { days } of forecasts) {
    const today = daylightDayFor(days, todayKey);
    if (today === undefined) continue;
    const which = targetDay(now, today.sunset);
    if (daylightDayFor(days, which) !== undefined) return which;
  }
  return undefined;
}

/** True when some forecast has daylight for the day. */
function covers(forecasts: readonly LaunchForecast[], day: DayKey): boolean {
  return forecasts.some((f) => daylightDayFor(f.days, day) !== undefined);
}

interface Loaded {
  forecasts: LaunchForecast[];
  day: DayKey;
  fetchedAt: number;
  isOffline: boolean;
}

/** Which forecast to load: the main one or a single day, and the day it must cover. */
interface Source {
  cache: ForecastCache;
  /** Set for a single-day fetch. */
  fetchDay?: DayKey | undefined;
  /** The day to evaluate, from the parsed forecasts. Undefined when they don't cover it. */
  dayFor: (forecasts: readonly LaunchForecast[]) => DayKey | undefined;
}

/** A cache is usable when it parses and covers the day. Otherwise it counts as no cache. */
function usableCache(
  cached: CachedForecast,
  launches: readonly Launch[],
  source: Source,
): { forecasts: LaunchForecast[]; day: DayKey; fetchedAt: number } | undefined {
  try {
    const forecasts = parseForecasts(cached.launchRaw, cached.neighborRaw, launches);
    const day = source.dayFor(forecasts);
    return day === undefined ? undefined : { forecasts, day, fetchedAt: cached.fetchedAt };
  } catch (error) {
    console.warn("Ignoring an unreadable forecast cache", error);
    return undefined;
  }
}

async function loadForecasts(
  request: RecommendationRequest,
  deps: RecommendationDeps,
  launches: Launch[],
  now: number,
  defaults: ScoringDefaults,
  source: Source,
): Promise<Loaded> {
  // Only a fresh cache is parsed up front. A stale one is parsed only if the fetch fails.
  const raw = source.cache.load(launches);
  const age = raw === undefined ? undefined : now - raw.fetchedAt;
  const maxAge = request.forceRefresh ? defaults.forcedRefreshMinIntervalMs : defaults.cacheMaxAgeMs;
  const fresh = age !== undefined && age >= 0 && age < maxAge;
  const fallback = fresh && raw !== undefined ? usableCache(raw, launches, source) : undefined;
  if (fallback !== undefined) return { ...fallback, isOffline: false };

  try {
    const { forecasts, launchRaw, neighborRaw } = await fetchForecasts(launches, {
      transport: deps.transport,
      baseURL: deps.baseURL,
      day: source.fetchDay,
    });
    const day = source.dayFor(forecasts);
    if (day === undefined) {
      throw new OpenMeteoError("unexpectedShape", "the forecast doesn't cover the target day");
    }
    source.cache.save({ launchRaw, neighborRaw, fetchedAt: now, launches });
    return { forecasts, day, fetchedAt: now, isOffline: false };
  } catch (error) {
    // A fresh cache was already tried (and found unusable) above; don't parse it twice.
    const cached = fresh || raw === undefined ? undefined : usableCache(raw, launches, source);
    if (cached === undefined) throw error;
    console.warn("Forecast fetch failed, using the cached forecast", error);
    return { ...cached, isOffline: true };
  }
}

/** Where the requested day comes from. Throws `DayOutOfRangeError` for a day that can't be asked for. */
function sourceFor(request: RecommendationRequest, deps: RecommendationDeps, now: number): Source {
  const today = denverDayKey(now);
  const { day } = request;
  if (day === undefined) return { cache: deps.cache, dayFor: (f) => resolveTargetDay(f, now) };
  if (day < today || day > addDays(today, MAX_DAYS_AHEAD)) throw new DayOutOfRangeError(day, today);
  const dayFor = (f: readonly LaunchForecast[]) => (covers(f, day) ? day : undefined);
  return day <= addDays(today, 1)
    ? { cache: deps.cache, dayFor }
    : { cache: deps.dayCache, fetchDay: day, dayFor };
}

/** Loads the forecast (cache or network), evaluates every open site for the day and ranks them. */
export async function getRecommendations(
  request: RecommendationRequest,
  deps: RecommendationDeps,
): Promise<RecommendationResult> {
  const now = deps.now();
  const today = denverDayKey(now);
  const defaults = deps.defaults ?? SCORING_DEFAULTS;
  const source = sourceFor(request, deps, now);
  const sites = await deps.siteProvider.sites();
  // Only open sites are fetched. `recommendSite` drops any evaluations of a closed one.
  const launches = sites.filter((s) => s.status.state === "open").flatMap((s) => s.launches);

  if (launches.length === 0) {
    const recs = sites.map((site) => recommendSite(site, []));
    const day = request.day ?? today;
    return { day, today, dayOver: false, fetchedAt: now, isOffline: false, sites: rankSites(recs) };
  }

  const { forecasts, day, fetchedAt, isOffline } = await loadForecasts(
    request,
    deps,
    launches,
    now,
    defaults,
    source,
  );
  const byLaunch = new Map(forecasts.map((f) => [f.launchID, f] as const));

  const recs = sites.map((site) => {
    // Closed sites' launches weren't fetched, so they have no forecast here.
    const evaluations = site.launches.flatMap((launch) => {
      const forecast = byLaunch.get(launch.id);
      return forecast === undefined ? [] : [evaluateLaunch(site, launch, forecast, day, now, defaults)];
    });
    return recommendSite(site, evaluations);
  });
  const dayOver = day === today && defaultDay(forecasts, now) !== today;
  return { day, today, dayOver, fetchedAt, isOffline, sites: rankSites(recs) };
}
