import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createForecastCache } from "../../../src/core/forecast/forecastCache";
import type { ForecastCache } from "../../../src/core/forecast/forecastCache";
import { OpenMeteoError, parseForecasts } from "../../../src/core/forecast/openMeteoClient";
import type { Transport } from "../../../src/core/forecast/openMeteoClient";
import { withDistances } from "../../../src/core/recommendation/ranker";
import { getRecommendations, resolveTargetDay } from "../../../src/core/recommendation/recommendationService";
import type { RecommendationDeps } from "../../../src/core/recommendation/recommendationService";
import { SCORING_DEFAULTS } from "../../../src/core/scoring/defaults";
import { denverDayKey } from "../../../src/core/time";
import { windowLabel } from "../../../src/core/scoring/windowFinder";
import { bundledSiteProvider } from "../../../src/core/sites/siteProvider";
import type { Launch, Site } from "../../../src/core/sites/site";
import launchesJSON from "../../fixtures/openmeteo-launches.json?raw";
import neighborsJSON from "../../fixtures/openmeteo-neighbors.json?raw";
import launchesURL from "../../fixtures/openmeteo-launches.url.txt?raw";
import neighborsURL from "../../fixtures/openmeteo-neighbors.url.txt?raw";
import { mapStore } from "../../support/builders";

const MIN_MS = 60_000;

function never(): never {
  throw new Error("expected a value");
}
/** 2026-11-07 11:00 MST. The fixture covers Nov 7 and Nov 8 (sunset Nov 7 17:01 MST). */
const NOW = Date.UTC(2026, 10, 7, 18, 0, 0);
/** 2026-11-07 18:00 MST, after sunset: the target is Nov 8. */
const NOW_EVENING = Date.UTC(2026, 10, 8, 1, 0, 0);
/** 2026-11-08 18:00 MST: tomorrow (Nov 9) is not in the fixture. */
const NOW_UNCOVERED = Date.UTC(2026, 10, 9, 1, 0, 0);

/** The three real sites the fixture was recorded for, trimmed to the recorded launch, and Copper (closed). */
let sites: Site[] = [];

beforeAll(async () => {
  const all = await bundledSiteProvider().sites();
  const trimmed = (siteID: string, launchID: string): Site => {
    const site = all.find((s) => s.id === siteID);
    const launch = site?.launches.find((l) => l.id === launchID);
    if (site === undefined || launch === undefined) throw new Error(`no ${launchID}`);
    return { ...site, launches: [launch] };
  };
  const copper = all.find((s) => s.id === "rmhpa/copper-mountain");
  if (copper === undefined) throw new Error("no copper");
  sites = [
    trimmed("rmhpa/glenwood-lookout-mtn", "rmhpa/glenwood-lookout-mtn/north"),
    trimmed("rmhpa/crested-butte", "rmhpa/crested-butte/browns"),
    trimmed("rmhpa/boulder-wonderland", "rmhpa/boulder-wonderland/upper"),
    copper,
  ];
});

const openLaunches = (): Launch[] =>
  sites.filter((s) => s.status.state === "open").flatMap((s) => s.launches);

interface Stub {
  transport: Transport;
  urls: string[];
}

/** Serves the recorded bodies only for the recorded URLs, so a wrong request fails loudly. */
function fixtureTransport(): Stub {
  const urls: string[] = [];
  const transport: Transport = async (url) => {
    urls.push(url);
    if (url === launchesURL.trim()) return { status: 200, body: launchesJSON };
    if (url === neighborsURL.trim()) return { status: 200, body: neighborsJSON };
    throw new Error(`unexpected request: ${url}`);
  };
  return { transport, urls };
}

function failingTransport(status = 500): Stub {
  const urls: string[] = [];
  const transport: Transport = async (url) => {
    urls.push(url);
    return { status, body: "{}" };
  };
  return { transport, urls };
}

function throwingTransport(): Stub {
  const urls: string[] = [];
  const transport: Transport = async (url) => {
    urls.push(url);
    throw new Error("offline");
  };
  return { transport, urls };
}

function deps(stub: Stub, cache: ForecastCache, now = NOW): RecommendationDeps {
  return {
    siteProvider: { sites: async () => sites },
    transport: stub.transport,
    cache,
    now: () => now,
  };
}

function seed(cache: ForecastCache, fetchedAt: number): void {
  cache.save({ launchRaw: launchesJSON, neighborRaw: neighborsJSON, fetchedAt, launches: openLaunches() });
}

afterEach(() => vi.restoreAllMocks());

describe("getRecommendations", () => {
  it("ranksTheFixtureSitesAndExcludesClosedOnesFromTheRequest", async () => {
    const stub = fixtureTransport();
    const cache = createForecastCache(mapStore());
    const result = await getRecommendations({ forceRefresh: false }, deps(stub, cache));

    expect(stub.urls.sort()).toEqual([launchesURL.trim(), neighborsURL.trim()].sort());
    expect(result.day).toBe("today");
    expect(result.fetchedAt).toBe(NOW);
    expect(result.isOffline).toBe(false);
    expect(result.sites.map((r) => r.site.id).sort()).toEqual(sites.map((s) => s.id).sort());
    const last = result.sites[result.sites.length - 1];
    expect(last?.site.id).toBe("rmhpa/copper-mountain");
    expect(last?.launches).toEqual([]);
    expect(last?.best).toBeUndefined();
    for (const r of result.sites.slice(0, 3)) {
      expect(r.launches).toHaveLength(1);
      const daylight = r.launches[0]?.daylight ?? [];
      expect(daylight.length).toBeGreaterThan(0);
      // Both models are evaluated for every daylight hour.
      expect(daylight.every((row) => row.rrfs !== undefined && row.rrfsHour !== undefined)).toBe(true);
      expect(r.best === undefined).toBe(r.mainReason !== undefined);
    }
    // Windows come first, ordered by score.
    const scores = result.sites.flatMap((r) => (r.best === undefined ? [] : [r.best.window.score]));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const firstWithout = result.sites.findIndex((r) => r.best === undefined);
    expect(result.sites.slice(firstWithout).every((r) => r.best === undefined)).toBe(true);
    // Gusts aren't scored: with the real limits, the recorded day's ECMWF gust factors (up to
    // 14 mph) no longer cap Boulder at flyable, so it gets its window.
    const boulder = result.sites.find((r) => r.site.id === "rmhpa/boulder-wonderland");
    expect(windowLabel(boulder?.best?.window ?? never())).toBe("11:00\u201317:00");

  });

  it("withPermissiveLimitsWindowsAreRankedAheadOfNoWindowAndClosedSites", async () => {
    // Loosen the limits and directions so wind speed and direction rule nothing out.
    const anyDirection = [{ from: 0, to: 360 }];
    const loose = sites.map((x) => ({
      ...x,
      limits: { minMph: 0, maxMph: 40, gustFactorMph: 40 },
      launches: x.launches.map((l) => ({ ...l, directions: { ok: anyDirection, ideal: anyDirection } })),
    }));
    const cache = createForecastCache(mapStore());
    const result = await getRecommendations(
      { forceRefresh: false },
      { ...deps(fixtureTransport(), cache), siteProvider: { sites: async () => loose } },
    );
    expect(result.sites.map((r) => r.site.id)).toEqual([
      "rmhpa/boulder-wonderland",
      "rmhpa/glenwood-lookout-mtn",
      "rmhpa/crested-butte",
      "rmhpa/copper-mountain",
    ]);
    const [boulder, glenwood, butte] = result.sites;
    expect(boulder?.best?.launch.id).toBe("rmhpa/boulder-wonderland/upper");
    expect(boulder?.best?.window.confidence).toBe("high");
    expect(glenwood?.best?.window.confidence).toBe("medium");
    expect(windowLabel(boulder?.best?.window ?? never())).toBe("11:00\u201317:00");
    expect((boulder?.best?.window.score ?? 0) > (glenwood?.best?.window.score ?? 1)).toBe(true);
    expect(boulder?.mainReason).toBeUndefined();
    expect(butte?.best).toBeUndefined();
    expect(butte?.mainReason?.kind).toBe("preThermal");
  });

  it("savesTheFetchedResponsesToTheCache", async () => {
    const cache = createForecastCache(mapStore());
    await getRecommendations({ forceRefresh: false }, deps(fixtureTransport(), cache));
    expect(cache.load(openLaunches())).toEqual({
      launchRaw: launchesJSON,
      neighborRaw: neighborsJSON,
      fetchedAt: NOW,
    });
  });

  it("aFreshCacheMeansNoFetch", async () => {
    const cache = createForecastCache(mapStore());
    seed(cache, NOW - 59 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations({ forceRefresh: false }, deps(stub, cache));
    expect(stub.urls).toEqual([]);
    expect(result.fetchedAt).toBe(NOW - 59 * MIN_MS);
    expect(result.isOffline).toBe(false);
    expect(result.sites).toHaveLength(4);
  });

  it("aCacheExactlyAtTheMaximumAgeIsStale", async () => {
    const cache = createForecastCache(mapStore());
    seed(cache, NOW - SCORING_DEFAULTS.cacheMaxAgeMs);
    const stub = fixtureTransport();
    await getRecommendations({ forceRefresh: false }, deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
  });

  it("aStaleCacheTriggersAFetchAndIsReplaced", async () => {
    const cache = createForecastCache(mapStore());
    seed(cache, NOW - 61 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations({ forceRefresh: false }, deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.fetchedAt).toBe(NOW);
    expect(cache.load(openLaunches())?.fetchedAt).toBe(NOW);
  });

  it("aFetchThatThrowsWithACachePresentIsOffline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = createForecastCache(mapStore());
    seed(cache, NOW - 3 * 60 * MIN_MS);
    const stub = throwingTransport();
    const result = await getRecommendations({ forceRefresh: false }, deps(stub, cache));
    expect(stub.urls.length).toBeGreaterThan(0);
    expect(result.isOffline).toBe(true);
    expect(result.fetchedAt).toBe(NOW - 3 * 60 * MIN_MS);
    expect(result.sites).toHaveLength(4);
    // The failed fetch must not clobber the cache.
    expect(cache.load(openLaunches())?.fetchedAt).toBe(NOW - 3 * 60 * MIN_MS);
  });

  it("aFetchThatThrowsWithNoCacheThrows", async () => {
    const cache = createForecastCache(mapStore());
    await expect(
      getRecommendations({ forceRefresh: false }, deps(throwingTransport(), cache)),
    ).rejects.toThrow("offline");
  });

  it("http429CountsAsAFetchFailureAndKeepsItsStatus", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const empty = createForecastCache(mapStore());
    const error = await getRecommendations({ forceRefresh: false }, deps(failingTransport(429), empty)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenMeteoError);
    expect((error as OpenMeteoError).status).toBe(429);
    expect((error as OpenMeteoError).message).toContain("rate limit");

    const cache = createForecastCache(mapStore());
    seed(cache, NOW - 2 * 60 * MIN_MS);
    const result = await getRecommendations({ forceRefresh: false }, deps(failingTransport(429), cache));
    expect(result.isOffline).toBe(true);
  });

  it("forceRefreshFetchesEvenWhenTheCacheIsFresh", async () => {
    const cache = createForecastCache(mapStore());
    seed(cache, NOW - 30 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations({ forceRefresh: true }, deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.fetchedAt).toBe(NOW);
  });

  it("forceRefreshWithinFiveMinutesOfTheLastFetchUsesTheCache", async () => {
    const cache = createForecastCache(mapStore());
    seed(cache, NOW - 4 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations({ forceRefresh: true }, deps(stub, cache));
    expect(stub.urls).toEqual([]);
    expect(result.fetchedAt).toBe(NOW - 4 * MIN_MS);
    expect(result.isOffline).toBe(false);
  });

  it("forceRefreshAtExactlyFiveMinutesFetches", async () => {
    const cache = createForecastCache(mapStore());
    seed(cache, NOW - SCORING_DEFAULTS.forcedRefreshMinIntervalMs);
    const stub = fixtureTransport();
    await getRecommendations({ forceRefresh: true }, deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
  });

  it("aCacheForADifferentLaunchListIsNotUsed", async () => {
    const cache = createForecastCache(mapStore());
    cache.save({
      launchRaw: launchesJSON,
      neighborRaw: neighborsJSON,
      fetchedAt: NOW - MIN_MS,
      launches: openLaunches().slice(0, 2),
    });
    const stub = fixtureTransport();
    await getRecommendations({ forceRefresh: false }, deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
  });

  it("aCorruptCachedBodyIsTreatedAsNoCache", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = createForecastCache(mapStore());
    cache.save({ launchRaw: "not json", neighborRaw: "[]", fetchedAt: NOW - MIN_MS, launches: openLaunches() });
    const stub = fixtureTransport();
    const result = await getRecommendations({ forceRefresh: false }, deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.fetchedAt).toBe(NOW);
  });

  it("aCacheMissingTheTargetDayIsNotUsed", async () => {
    // Fresh by age, but at this time the target day (Nov 9) isn't in it. Offline, that means no data.
    const cache = createForecastCache(mapStore());
    seed(cache, NOW_UNCOVERED - MIN_MS);
    const stub = throwingTransport();
    await expect(
      getRecommendations({ forceRefresh: false }, deps(stub, cache, NOW_UNCOVERED)),
    ).rejects.toThrow("offline");
    expect(stub.urls.length).toBeGreaterThan(0);
  });

  it("aFetchThatDoesntCoverTheTargetDayIsAFailureAndIsNotCached", async () => {
    const cache = createForecastCache(mapStore());
    const error = await getRecommendations(
      { forceRefresh: false },
      deps(fixtureTransport(), cache, NOW_UNCOVERED),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenMeteoError);
    expect(cache.load(openLaunches())).toBeUndefined();
  });

  it("targetsTomorrowAfterTodaysSunset", async () => {
    const cache = createForecastCache(mapStore());
    const result = await getRecommendations({ forceRefresh: false }, deps(fixtureTransport(), cache, NOW_EVENING));
    expect(result.day).toBe("tomorrow");
    const open = result.sites.filter((r) => r.site.status.state === "open");
    expect(open).toHaveLength(3);
    for (const r of open) {
      const daylight = r.launches[0]?.daylight ?? [];
      expect(daylight.length).toBeGreaterThan(0);
      expect(daylight.every((h) => denverDayKey(h.time) === "2026-11-08")).toBe(true);
    }
  });

  it("withALocationAddsDistancesToTheFirstLaunch", async () => {
    const cache = createForecastCache(mapStore());
    const fetched = await getRecommendations({ forceRefresh: false }, deps(fixtureTransport(), cache));
    expect(fetched.sites.every((r) => r.distanceM === undefined)).toBe(true);
    const result = withDistances(fetched, { latitude: 39.5428, longitude: -107.3003 });
    const glenwood = result.sites.find((r) => r.site.id === "rmhpa/glenwood-lookout-mtn");
    expect(glenwood?.distanceM).toBeCloseTo(0, 0);
    expect(result.sites.every((r) => r.distanceM !== undefined)).toBe(true);
  });

  it("anOpenSiteCatalogWithoutOpenSitesNeverFetches", async () => {
    const stub = fixtureTransport();
    const cache = createForecastCache(mapStore());
    const onlyClosed = sites.filter((s) => s.status.state === "closed");
    const result = await getRecommendations(
      { forceRefresh: false },
      { ...deps(stub, cache), siteProvider: { sites: async () => onlyClosed } },
    );
    expect(stub.urls).toEqual([]);
    expect(result.sites.map((r) => r.site.id)).toEqual(["rmhpa/copper-mountain"]);
  });

  it("aSiteProviderFailurePropagates", async () => {
    const cache = createForecastCache(mapStore());
    await expect(
      getRecommendations(
        { forceRefresh: false },
        { ...deps(fixtureTransport(), cache), siteProvider: { sites: async () => Promise.reject(new Error("bad catalog")) } },
      ),
    ).rejects.toThrow("bad catalog");
  });
});

describe("resolveTargetDay", () => {
  it("uses the first forecast that has daylight days", () => {
    const [a, b] = parseForecasts(launchesJSON, neighborsJSON, openLaunches());
    if (a === undefined || b === undefined) never();
    expect(resolveTargetDay([{ ...a, days: [] }, b], NOW)).toBe("today");
    expect(resolveTargetDay([{ ...a, days: [] }, { ...b, days: [] }], NOW)).toBeUndefined();
  });
});
