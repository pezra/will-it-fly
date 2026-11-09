import type { LaunchForecast } from "../forecast/models";
import { fetchForecasts, OpenMeteoError, parseForecasts, splitRaw } from "../forecast/openMeteoClient";
import type { Transport } from "../forecast/openMeteoClient";
import { dayKey, mainKey } from "../forecast/siteForecastCache";
import type {
  CachedSiteForecast,
  SiteForecastCache,
  SiteForecastSave,
} from "../forecast/siteForecastCache";
import { SCORING_DEFAULTS } from "../scoring/defaults";
import type { ScoringDefaults } from "../scoring/defaults";
import { daylightDayFor, targetDay } from "../scoring/windowFinder";
import type { SiteProvider } from "../sites/siteProvider";
import type { Launch, Site } from "../sites/site";
import { addDays, denverDayKey, formatDayKey } from "../time";
import type { DayKey } from "../time";
import { evaluateLaunch } from "./evaluateLaunch";
import { rankSites, recommendSite } from "./ranker";
import type { RecommendationResult } from "./types";

export interface RecommendationRequest {
  forceRefresh: boolean;
  /** The sites to evaluate. Only these are fetched and returned; unknown ids are ignored. */
  siteIds: readonly string[];
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
  /** Holds each site's forecast: the main one (today and tomorrow) and single days after tomorrow. */
  cache: SiteForecastCache;
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
  /** The site's cache entry key. */
  keyFor: (siteId: string) => string;
  /** Set for a single-day fetch. */
  fetchDay?: DayKey | undefined;
  /** The day to evaluate, from the parsed forecasts. Undefined when they don't cover it. */
  dayFor: (forecasts: readonly LaunchForecast[]) => DayKey | undefined;
}

interface Usable {
  forecasts: LaunchForecast[];
  fetchedAt: number;
}

/** A cache entry is usable when it parses and covers the day. Otherwise it counts as no entry. */
function usableEntry(
  cached: CachedSiteForecast,
  launches: readonly Launch[],
  source: Source,
): Usable | undefined {
  try {
    const forecasts = parseForecasts(cached.launchRaw, cached.neighborRaw, launches);
    return source.dayFor(forecasts) === undefined ? undefined : { forecasts, fetchedAt: cached.fetchedAt };
  } catch (error) {
    console.warn("Ignoring an unreadable forecast cache entry", error);
    return undefined;
  }
}

/** A site whose cached entry can't be used as is. */
interface ToFetch {
  site: Site;
  key: string;
  /** The entry, only when it is too old: a fresh one was already found unusable. */
  stale: CachedSiteForecast | undefined;
}

/**
 * Loads each site's forecast from its fresh cache entry, and fetches the rest in one request pair.
 * If that fetch fails, each of those sites falls back to its stale entry, or the error is rethrown.
 */
async function loadForecasts(
  request: RecommendationRequest,
  deps: RecommendationDeps,
  sites: readonly Site[],
  now: number,
  defaults: ScoringDefaults,
  source: Source,
): Promise<Loaded> {
  const snapshot = deps.cache.open();
  const maxAge = request.forceRefresh ? defaults.forcedRefreshMinIntervalMs : defaults.cacheMaxAgeMs;
  const loaded = new Map<string, Usable>();
  const used: string[] = [];
  const toFetch: ToFetch[] = [];
  for (const site of sites) {
    const key = source.keyFor(site.id);
    // Only a fresh entry is parsed up front. A stale one is parsed only if the fetch fails.
    const cached = snapshot.get(key, site.launches);
    const age = cached === undefined ? undefined : now - cached.fetchedAt;
    const fresh = age !== undefined && age >= 0 && age < maxAge;
    const usable = fresh && cached !== undefined ? usableEntry(cached, site.launches, source) : undefined;
    if (usable !== undefined) {
      loaded.set(site.id, usable);
      used.push(key);
    } else {
      toFetch.push({ site, key, stale: fresh ? undefined : cached });
    }
  }

  let isOffline = false;
  const saves: SiteForecastSave[] = [];
  if (toFetch.length > 0) {
    try {
      const { forecasts, launchRaw, neighborRaw } = await fetchForecasts(
        toFetch.flatMap(({ site }) => site.launches),
        { transport: deps.transport, baseURL: deps.baseURL, day: source.fetchDay },
      );
      if (source.dayFor(forecasts) === undefined) {
        throw new OpenMeteoError("unexpectedShape", "the forecast doesn't cover the target day");
      }
      const counts = toFetch.map(({ site }) => site.launches.length);
      // One slice per site. `forecasts` is in launch order, so each site takes its next `count`.
      const slices = splitRaw(launchRaw, neighborRaw, counts);
      let start = 0;
      toFetch.forEach(({ site, key }, i) => {
        const end = start + site.launches.length;
        loaded.set(site.id, { forecasts: forecasts.slice(start, end), fetchedAt: now });
        start = end;
        const slice = slices[i];
        if (slice !== undefined) saves.push({ key, launches: site.launches, fetchedAt: now, ...slice });
      });
    } catch (error) {
      for (const { site, key, stale } of toFetch) {
        const usable = stale === undefined ? undefined : usableEntry(stale, site.launches, source);
        if (usable === undefined) throw error;
        loaded.set(site.id, usable);
        used.push(key);
      }
      console.warn("Forecast fetch failed, using the cached forecast", error);
      isOffline = true;
    }
  }
  snapshot.commit({ saves, used, now });

  // In site order, whichever were cached: the first covering forecast decides the day.
  const parts = sites.map((site) => loaded.get(site.id) ?? { forecasts: [], fetchedAt: now });
  const forecasts = parts.flatMap((p) => p.forecasts);
  const day = source.dayFor(forecasts);
  if (day === undefined) {
    throw new OpenMeteoError("unexpectedShape", "the forecast doesn't cover the target day");
  }
  const fetchedAt = Math.min(...parts.map((p) => p.fetchedAt));
  return { forecasts, day, fetchedAt, isOffline };
}

/** Where the requested day comes from. Throws `DayOutOfRangeError` for a day that can't be asked for. */
function sourceFor(request: RecommendationRequest, now: number): Source {
  const today = denverDayKey(now);
  const { day } = request;
  if (day === undefined) return { keyFor: mainKey, dayFor: (f) => resolveTargetDay(f, now) };
  if (day < today || day > addDays(today, MAX_DAYS_AHEAD)) throw new DayOutOfRangeError(day, today);
  const dayFor = (f: readonly LaunchForecast[]) => (covers(f, day) ? day : undefined);
  return day <= addDays(today, 1)
    ? { keyFor: mainKey, dayFor }
    : { keyFor: (siteId) => dayKey(day, siteId), fetchDay: day, dayFor };
}

/**
 * Loads the forecast (cache or network) for the requested sites, evaluates the open ones for the day
 * and ranks them. Unknown ids are ignored.
 */
export async function getRecommendations(
  request: RecommendationRequest,
  deps: RecommendationDeps,
): Promise<RecommendationResult> {
  const now = deps.now();
  const today = denverDayKey(now);
  const defaults = deps.defaults ?? SCORING_DEFAULTS;
  const source = sourceFor(request, now);
  const wanted = new Set(request.siteIds);
  // Catalog order, not request order: the request URL and the day don't depend on how ids were listed.
  const sites = (await deps.siteProvider.sites()).filter((s) => wanted.has(s.id));
  // Only open sites are fetched. `recommendSite` drops any evaluations of a closed one.
  const open = sites.filter((s) => s.status.state === "open" && s.launches.length > 0);

  if (open.length === 0) {
    const recs = sites.map((site) => recommendSite(site, []));
    const day = request.day ?? today;
    return { day, today, dayOver: false, fetchedAt: now, isOffline: false, sites: rankSites(recs) };
  }

  const { forecasts, day, fetchedAt, isOffline } = await loadForecasts(
    request,
    deps,
    open,
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
