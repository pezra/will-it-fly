import type { ForecastCache } from "../forecast/forecastCache";
import type { LaunchForecast } from "../forecast/models";
import { fetchForecasts, OpenMeteoError, parseForecasts } from "../forecast/openMeteoClient";
import type { Transport } from "../forecast/openMeteoClient";
import { SCORING_DEFAULTS } from "../scoring/defaults";
import type { ScoringDefaults } from "../scoring/defaults";
import { daylightDayFor, targetDay } from "../scoring/windowFinder";
import type { TargetDay } from "../scoring/windowFinder";
import type { SiteProvider } from "../sites/siteProvider";
import type { Coordinate, Launch } from "../sites/site";
import { evaluateLaunch } from "./evaluateLaunch";
import { rankSites, recommendSite } from "./ranker";
import type { RecommendationResult } from "./types";

export interface RecommendationRequest {
  userLocation?: Coordinate | undefined;
  forceRefresh: boolean;
}

export interface RecommendationDeps {
  siteProvider: SiteProvider;
  transport: Transport;
  baseURL?: string | undefined;
  cache: ForecastCache;
  now: () => number;
  defaults?: ScoringDefaults | undefined;
}

/**
 * The target day, from the first launch's sunset (it decides for every site). Undefined when the
 * forecast doesn't cover today or the target day.
 */
export function resolveTargetDay(
  forecasts: readonly LaunchForecast[],
  now: number,
): TargetDay | undefined {
  const first = forecasts[0];
  if (first === undefined) return undefined;
  const today = daylightDayFor(first.days, "today", now);
  if (today === undefined) return undefined;
  const which = targetDay(now, today.sunset);
  return daylightDayFor(first.days, which, now) === undefined ? undefined : which;
}

interface Loaded {
  forecasts: LaunchForecast[];
  day: TargetDay;
  fetchedAt: number;
  isOffline: boolean;
}

/** A cache is usable when it parses and covers the target day. Otherwise it counts as no cache. */
function usableCache(
  cache: ForecastCache,
  launches: readonly Launch[],
  now: number,
): { forecasts: LaunchForecast[]; day: TargetDay; fetchedAt: number } | undefined {
  const cached = cache.load(launches);
  if (cached === undefined) return undefined;
  try {
    const forecasts = parseForecasts(cached.launchRaw, cached.neighborRaw, launches);
    const day = resolveTargetDay(forecasts, now);
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
): Promise<Loaded> {
  const cached = usableCache(deps.cache, launches, now);
  if (cached !== undefined) {
    const age = now - cached.fetchedAt;
    const maxAge = request.forceRefresh ? defaults.forcedRefreshMinIntervalMs : defaults.cacheMaxAgeMs;
    if (age >= 0 && age < maxAge) return { ...cached, isOffline: false };
  }

  try {
    const options = deps.baseURL === undefined
      ? { transport: deps.transport }
      : { transport: deps.transport, baseURL: deps.baseURL };
    const { forecasts, launchRaw, neighborRaw } = await fetchForecasts(launches, options);
    const day = resolveTargetDay(forecasts, now);
    if (day === undefined) {
      throw new OpenMeteoError("unexpectedShape", "the forecast doesn't cover the target day");
    }
    deps.cache.save({ launchRaw, neighborRaw, fetchedAt: now, launches });
    return { forecasts, day, fetchedAt: now, isOffline: false };
  } catch (error) {
    if (cached === undefined) throw error;
    console.warn("Forecast fetch failed, using the cached forecast", error);
    return { ...cached, isOffline: true };
  }
}

/** Loads the forecast (cache or network), evaluates every open site and ranks them. */
export async function getRecommendations(
  request: RecommendationRequest,
  deps: RecommendationDeps,
): Promise<RecommendationResult> {
  const now = deps.now();
  const defaults = deps.defaults ?? SCORING_DEFAULTS;
  const sites = await deps.siteProvider.sites();
  const launches = sites.filter((s) => s.status.state === "open").flatMap((s) => s.launches);

  if (launches.length === 0) {
    const recs = sites.map((site) => recommendSite(site, [], request.userLocation));
    return { day: "today", fetchedAt: now, isOffline: false, sites: rankSites(recs) };
  }

  const { forecasts, day, fetchedAt, isOffline } = await loadForecasts(
    request,
    deps,
    launches,
    now,
    defaults,
  );
  const byLaunch = new Map(forecasts.map((f) => [f.launchID, f] as const));

  const recs = sites.map((site) => {
    const evaluations =
      site.status.state === "closed"
        ? []
        : site.launches.flatMap((launch) => {
            const forecast = byLaunch.get(launch.id);
            return forecast === undefined
              ? []
              : [evaluateLaunch(site, launch, forecast, day, now, defaults)];
          });
    return recommendSite(site, evaluations, request.userLocation);
  });
  return { day, fetchedAt, isOffline, sites: rankSites(recs) };
}
