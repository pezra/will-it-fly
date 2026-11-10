import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  OpenMeteoError,
  launchRequestURL,
  neighborRequestURL,
  parseForecasts,
} from "../../../src/core/forecast/openMeteoClient";
import type { RawSlice, Transport } from "../../../src/core/forecast/openMeteoClient";
import { createSiteForecastCache, dayKey, mainKey } from "../../../src/core/forecast/siteForecastCache";
import type { SiteForecastCache } from "../../../src/core/forecast/siteForecastCache";
import type { RemovableStore } from "../../../src/core/keyValueStore";
import { evaluateForecast } from "../../../src/core/recommendation/evaluateLaunch";
import { withDistances } from "../../../src/core/recommendation/ranker";
import {
  DayOutOfRangeError,
  getRecommendations,
  resolveTargetDay,
} from "../../../src/core/recommendation/recommendationService";
import type {
  RecommendationDeps,
  RecommendationRequest,
} from "../../../src/core/recommendation/recommendationService";
import { SCORING_DEFAULTS } from "../../../src/core/scoring/defaults";
import { byTime, denverDayKey } from "../../../src/core/time";
import type { DayKey } from "../../../src/core/time";
import { windowLabel } from "../../../src/core/scoring/windowFinder";
import type { Launch, Site } from "../../../src/core/sites/site";
import launchesJSON from "../../fixtures/openmeteo-launches.json?raw";
import neighborsJSON from "../../fixtures/openmeteo-neighbors.json?raw";
import launchesURL from "../../fixtures/openmeteo-launches.url.txt?raw";
import neighborsURL from "../../fixtures/openmeteo-neighbors.url.txt?raw";
import { mapStore } from "../../support/builders";
import {
  BOULDER,
  BUTTE,
  COPPER,
  GLENWOOD,
  fixtureResponse,
  fixtureSites,
  fixtureSlice,
} from "../../support/fixtureWeather";

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
/** Boulder's Nov 7 sunset in the fixture, 16:52 MST. Glenwood's and Crested Butte's are ~9 min later. */
const BOULDER_SUNSET = 1794095532 * 1000;
/** 2026-11-05 11:00 MST: the fixture's Nov 7 is the day after tomorrow, so it is fetched on its own. */
const NOW_EARLIER = Date.UTC(2026, 10, 5, 18, 0, 0);

/** The three real sites the fixture was recorded for, trimmed to the recorded launch, and Copper (closed). */
let sites: Site[] = [];

beforeAll(async () => {
  sites = await fixtureSites();
});

const openSites = (): Site[] => sites.filter((s) => s.status.state === "open");
const openLaunches = (): Launch[] => openSites().flatMap((s) => s.launches);
const allIds = (): string[] => sites.map((s) => s.id);

function site(id: string): Site {
  return sites.find((s) => s.id === id) ?? never();
}

/** A request for every site, plus overrides. */
function request(overrides: Partial<RecommendationRequest> = {}): RecommendationRequest {
  return { forceRefresh: false, siteIds: allIds(), model: "ecmwf", ...overrides };
}

interface Stub {
  transport: Transport;
  urls: string[];
}

/**
 * Serves the recorded bodies (or `launchBody` for the launch request) only for the recorded URLs, so
 * a wrong request fails loudly.
 */
function fixtureTransport(launchBody = launchesJSON): Stub {
  const urls: string[] = [];
  const transport: Transport = async (url) => {
    urls.push(url);
    if (url === launchesURL.trim()) return { status: 200, body: launchBody };
    if (url === neighborsURL.trim()) return { status: 200, body: neighborsJSON };
    throw new Error(`unexpected request: ${url}`);
  };
  return { transport, urls };
}

/** Serves the recorded bodies for the single-day URLs of `day`. */
function dayTransport(day: string): Stub {
  const urls: string[] = [];
  const transport: Transport = async (url) => {
    urls.push(url);
    if (url === launchRequestURL(openLaunches(), undefined, day)) return { status: 200, body: launchesJSON };
    if (url === neighborRequestURL(openLaunches(), undefined, day)) return { status: 200, body: neighborsJSON };
    throw new Error(`unexpected request: ${url}`);
  };
  return { transport, urls };
}

/** Serves the recorded slices of exactly these sites (in this order), and fails any other request. */
function subsetTransport(ids: readonly string[], day?: DayKey): Stub {
  const urls: string[] = [];
  const transport: Transport = async (url) => {
    urls.push(url);
    const body = fixtureResponse(sites, ids, url, day);
    if (body === undefined) throw new Error(`unexpected request: ${url}`);
    return { status: 200, body };
  };
  return { transport, urls };
}

/** The `latitude=` values a request asked for. */
function latitudes(url: string): string[] {
  return new URL(url).searchParams.get("latitude")?.split(",") ?? [];
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

function newCache(): SiteForecastCache {
  return createSiteForecastCache(mapStore());
}

function deps(stub: Stub, cache: SiteForecastCache, now = NOW): RecommendationDeps {
  return {
    siteProvider: { sites: async () => sites },
    transport: stub.transport,
    cache,
    now: () => now,
  };
}

/** Saves the recorded slices of these sites (every open one by default) under `key`. */
function seed(
  cache: SiteForecastCache,
  fetchedAt: number,
  ids: readonly string[] = openSites().map((s) => s.id),
  key: (id: string) => string = mainKey,
  slice: (id: string) => RawSlice = fixtureSlice,
): void {
  const saves = ids.map((id) => ({ key: key(id), launches: site(id).launches, fetchedAt, ...slice(id) }));
  cache.open().commit({ saves, used: [], now: fetchedAt });
}

/** The cached entry's fetch time, if any. */
function cachedAt(cache: SiteForecastCache, id: string, key: (id: string) => string = mainKey): number | undefined {
  return cache.open().get(key(id), site(id).launches)?.fetchedAt;
}

afterEach(() => vi.restoreAllMocks());

describe("getRecommendations", () => {
  it("ranksTheFixtureSitesAndExcludesClosedOnesFromTheRequest", async () => {
    const stub = fixtureTransport();
    const cache = newCache();
    const result = await getRecommendations(request(), deps(stub, cache));

    expect(stub.urls.sort()).toEqual([launchesURL.trim(), neighborsURL.trim()].sort());
    expect(result.day).toBe("2026-11-07");
    expect(result.today).toBe("2026-11-07");
    expect(result.dayOver).toBe(false);
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
      expect(daylight.every((row) => row.check !== undefined)).toBe(true);
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
    const cache = newCache();
    const result = await getRecommendations(
      request(),
      { ...deps(fixtureTransport(), cache), siteProvider: { sites: async () => loose } },
    );
    expect(result.sites.map((r) => r.site.id)).toEqual([
      "rmhpa/boulder-wonderland",
      "rmhpa/crested-butte",
      "rmhpa/glenwood-lookout-mtn",
      "rmhpa/copper-mountain",
    ]);
    const [boulder, butte, glenwood] = result.sites;
    expect(boulder?.best?.launch.id).toBe("rmhpa/boulder-wonderland/upper");
    expect(boulder?.best?.window.confidence).toBe("high");
    // Low because Glenwood's light winds differ in direction between the models.
    expect(glenwood?.best?.window.confidence).toBe("low");
    expect(windowLabel(boulder?.best?.window ?? never())).toBe("11:00\u201317:00");
    expect((boulder?.best?.window.score ?? 0) > (glenwood?.best?.window.score ?? 1)).toBe(true);
    expect(boulder?.mainReason).toBeUndefined();
    // A sledder all afternoon costs points but doesn't cap the call.
    expect(butte?.call).toBe("good");
    expect(butte?.best?.window.hours.every((h) => h.reasons.some((r) => r.kind === "sledder"))).toBe(true);
    expect(windowLabel(butte?.best?.window ?? never())).toBe("11:00\u201318:00");
    // The fixture has no ridge lift or strong thermals, so each window is a sledder; only Glenwood
    // has a caution.
    expect(boulder?.best?.window.conditions).toEqual(["sledder"]);
    expect(butte?.best?.window.conditions).toEqual(["sledder"]);
    expect(boulder?.best?.window.cautions).toEqual([]);
    expect(glenwood?.best?.window.cautions.map((c) => c.kind)).toEqual(["neighborWind"]);
    expect(butte?.mainReason).toBeUndefined();
  });

  it("savesTheFetchedResponsesToTheCache", async () => {
    const cache = newCache();
    await getRecommendations(request(), deps(fixtureTransport(), cache));
    for (const { id, launches } of openSites()) {
      expect(cache.open().get(mainKey(id), launches)).toEqual({ ...fixtureSlice(id), fetchedAt: NOW });
    }
    // The closed site is never cached.
    expect(cache.open().get(mainKey(COPPER), site(COPPER).launches)).toBeUndefined();
  });

  it("aFreshCacheMeansNoFetch", async () => {
    const cache = newCache();
    seed(cache, NOW - 59 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toEqual([]);
    expect(result.fetchedAt).toBe(NOW - 59 * MIN_MS);
    expect(result.isOffline).toBe(false);
    expect(result.sites).toHaveLength(4);
  });

  it("aCacheExactlyAtTheMaximumAgeIsStale", async () => {
    const cache = newCache();
    seed(cache, NOW - SCORING_DEFAULTS.cacheMaxAgeMs);
    const stub = fixtureTransport();
    await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
  });

  it("aStaleCacheTriggersAFetchAndIsReplaced", async () => {
    const cache = newCache();
    seed(cache, NOW - 61 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.fetchedAt).toBe(NOW);
    expect(openSites().map((s) => cachedAt(cache, s.id))).toEqual([NOW, NOW, NOW]);
  });

  it("aFetchThatThrowsWithACachePresentIsOffline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = newCache();
    seed(cache, NOW - 3 * 60 * MIN_MS);
    const stub = throwingTransport();
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls.length).toBeGreaterThan(0);
    expect(result.isOffline).toBe(true);
    expect(result.fetchedAt).toBe(NOW - 3 * 60 * MIN_MS);
    expect(result.sites).toHaveLength(4);
    // The failed fetch must not clobber the cache.
    expect(cachedAt(cache, BOULDER)).toBe(NOW - 3 * 60 * MIN_MS);
  });

  it("aFetchThatThrowsWithNoCacheThrows", async () => {
    const cache = newCache();
    await expect(
      getRecommendations(request(), deps(throwingTransport(), cache)),
    ).rejects.toThrow("offline");
  });

  it("http429CountsAsAFetchFailureAndKeepsItsStatus", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const empty = newCache();
    const error = await getRecommendations(request(), deps(failingTransport(429), empty)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenMeteoError);
    expect((error as OpenMeteoError).status).toBe(429);
    expect((error as OpenMeteoError).message).toContain("rate limit");

    const cache = newCache();
    seed(cache, NOW - 2 * 60 * MIN_MS);
    const result = await getRecommendations(request(), deps(failingTransport(429), cache));
    expect(result.isOffline).toBe(true);
  });

  it("forceRefreshFetchesEvenWhenTheCacheIsFresh", async () => {
    const cache = newCache();
    seed(cache, NOW - 30 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations(request({ forceRefresh: true }), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.fetchedAt).toBe(NOW);
  });

  it("forceRefreshWithinFiveMinutesOfTheLastFetchUsesTheCache", async () => {
    const cache = newCache();
    seed(cache, NOW - 4 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations(request({ forceRefresh: true }), deps(stub, cache));
    expect(stub.urls).toEqual([]);
    expect(result.fetchedAt).toBe(NOW - 4 * MIN_MS);
    expect(result.isOffline).toBe(false);
  });

  it("forceRefreshAtExactlyFiveMinutesFetches", async () => {
    const cache = newCache();
    seed(cache, NOW - SCORING_DEFAULTS.forcedRefreshMinIntervalMs);
    const stub = fixtureTransport();
    await getRecommendations(request({ forceRefresh: true }), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
  });

  it("aCacheForADifferentLaunchListIsNotUsed", async () => {
    const cache = newCache();
    // Each entry was saved for a launch at another elevation.
    const saves = openSites().map(({ id, launches }) => ({
      key: mainKey(id),
      launches: launches.map((l) => ({ ...l, elevationFt: l.elevationFt + 1 })),
      fetchedAt: NOW - MIN_MS,
      ...fixtureSlice(id),
    }));
    cache.open().commit({ saves, used: [], now: NOW - MIN_MS });
    const stub = fixtureTransport();
    await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
  });

  it("aCorruptCachedBodyIsTreatedAsNoCache", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = newCache();
    seed(cache, NOW - MIN_MS, undefined, mainKey, () => ({ launchRaw: "not json", neighborRaw: "[]" }));
    const stub = fixtureTransport();
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.fetchedAt).toBe(NOW);
  });

  it("aCacheMissingTheTargetDayIsNotUsed", async () => {
    // Fresh by age, but at this time the target day (Nov 9) isn't in it. Offline, that means no data.
    const cache = newCache();
    seed(cache, NOW_UNCOVERED - MIN_MS);
    const stub = throwingTransport();
    await expect(
      getRecommendations(request(), deps(stub, cache, NOW_UNCOVERED)),
    ).rejects.toThrow("offline");
    expect(stub.urls.length).toBeGreaterThan(0);
  });

  it("aFetchThatDoesntCoverTheTargetDayIsAFailureAndIsNotCached", async () => {
    const cache = newCache();
    const error = await getRecommendations(
      request(),
      deps(fixtureTransport(), cache, NOW_UNCOVERED),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenMeteoError);
    expect(openSites().map((s) => cachedAt(cache, s.id))).toEqual([undefined, undefined, undefined]);
  });

  it("targetsTomorrowAfterTodaysSunset", async () => {
    const cache = newCache();
    const result = await getRecommendations(request(), deps(fixtureTransport(), cache, NOW_EVENING));
    expect(result.day).toBe("2026-11-08");
    expect(result.today).toBe("2026-11-07");
    const open = result.sites.filter((r) => r.site.status.state === "open");
    expect(open).toHaveLength(3);
    for (const r of open) {
      const daylight = r.launches[0]?.daylight ?? [];
      expect(daylight.length).toBeGreaterThan(0);
      expect(daylight.every((h) => denverDayKey(h.time) === "2026-11-08")).toBe(true);
    }
  });

  it("aRequestedTomorrowComesFromTheMainForecast", async () => {
    const stub = fixtureTransport();
    const cache = newCache();
    const result = await getRecommendations(request({ day: "2026-11-08" }), deps(stub, cache));
    expect(stub.urls.sort()).toEqual([launchesURL.trim(), neighborsURL.trim()].sort());
    expect(result.day).toBe("2026-11-08");
    expect(result.dayOver).toBe(false);
    const daylight = result.sites[0]?.launches[0]?.daylight ?? [];
    expect(daylight.length).toBeGreaterThan(0);
    expect(daylight.every((h) => denverDayKey(h.time) === "2026-11-08")).toBe(true);
    // Switching back to today reuses the cached main forecast.
    const today = await getRecommendations(request({ day: "2026-11-07" }), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(today.day).toBe("2026-11-07");
  });

  it("aRequestedTodayAfterSunsetIsOver", async () => {
    const cache = newCache();
    const result = await getRecommendations(
      request({ day: "2026-11-07" }),
      deps(fixtureTransport(), cache, NOW_EVENING),
    );
    expect(result.day).toBe("2026-11-07");
    expect(result.dayOver).toBe(true);
    expect(result.sites.every((r) => r.best === undefined)).toBe(true);
  });

  it("aLaterDayIsFetchedOnItsOwnIntoDayEntries", async () => {
    const stub = dayTransport("2026-11-07");
    const cache = newCache();
    const later = request({ day: "2026-11-07" });
    const result = await getRecommendations(later, deps(stub, cache, NOW_EARLIER));
    expect(stub.urls).toHaveLength(2);
    expect(stub.urls.every((u) => u.includes("start_date=2026-11-07&end_date=2026-11-07"))).toBe(true);
    expect(result.day).toBe("2026-11-07");
    expect(result.today).toBe("2026-11-05");
    expect(result.dayOver).toBe(false);
    const onDay = (id: string): string => dayKey("2026-11-07", id);
    for (const { id } of openSites()) {
      expect(cachedAt(cache, id)).toBeUndefined();
      expect(cachedAt(cache, id, onDay)).toBe(NOW_EARLIER);
    }
    // Not today, so the morning counts too (at 11:00 on the day itself, the window started at 11:00).
    const boulder = result.sites.find((r) => r.site.id === "rmhpa/boulder-wonderland");
    expect(windowLabel(boulder?.best?.window ?? never())).toBe("10:00\u201317:00");

    // The same day again is served from the day entries.
    await getRecommendations(later, deps(stub, cache, NOW_EARLIER + MIN_MS));
    expect(stub.urls).toHaveLength(2);
  });

  it("aDayEntryThatDoesntCoverItsDayIsNotUsed", async () => {
    const cache = newCache();
    // Fresh entries under the Nov 9 keys, but the cached responses cover Nov 7 and 8, not Nov 9.
    seed(cache, NOW_EARLIER - MIN_MS, undefined, (id) => dayKey("2026-11-09", id));
    const stub = throwingTransport();
    await expect(
      getRecommendations(request({ day: "2026-11-09" }), deps(stub, cache, NOW_EARLIER)),
    ).rejects.toThrow("offline");
    expect(stub.urls).toHaveLength(2);
  });

  it("aDayOutsideTheRangeIsRejectedWithoutFetching", async () => {
    const stub = fixtureTransport();
    const cache = newCache();
    for (const day of ["2026-11-06", "2026-11-22"]) {
      await expect(
        getRecommendations(request({ day }), deps(stub, cache)),
      ).rejects.toBeInstanceOf(DayOutOfRangeError);
    }
    expect(stub.urls).toEqual([]);
    // 14 days out is still allowed.
    await expect(
      getRecommendations(request({ day: "2026-11-21" }), deps(stub, cache)),
    ).rejects.toThrow("unexpected request");
  });

  it("withALocationAddsDistancesToTheFirstLaunch", async () => {
    const cache = newCache();
    const fetched = await getRecommendations(request(), deps(fixtureTransport(), cache));
    expect(fetched.sites.every((r) => r.distanceM === undefined)).toBe(true);
    const result = withDistances(fetched, { latitude: 39.5428, longitude: -107.3003 });
    const glenwood = result.sites.find((r) => r.site.id === "rmhpa/glenwood-lookout-mtn");
    expect(glenwood?.distanceM).toBeCloseTo(0, 0);
    expect(result.sites.every((r) => r.distanceM !== undefined)).toBe(true);
  });

  it("anOpenSiteCatalogWithoutOpenSitesNeverFetches", async () => {
    const stub = fixtureTransport();
    const cache = newCache();
    const onlyClosed = sites.filter((s) => s.status.state === "closed");
    const result = await getRecommendations(
      request(),
      { ...deps(stub, cache), siteProvider: { sites: async () => onlyClosed } },
    );
    expect(stub.urls).toEqual([]);
    expect(result.sites.map((r) => r.site.id)).toEqual(["rmhpa/copper-mountain"]);
  });

  it("aSiteProviderFailurePropagates", async () => {
    const cache = newCache();
    await expect(
      getRecommendations(
        request(),
        { ...deps(fixtureTransport(), cache), siteProvider: { sites: async () => Promise.reject(new Error("bad catalog")) } },
      ),
    ).rejects.toThrow("bad catalog");
  });
});

/** A map store that counts reads and writes. */
function countingStore(): RemovableStore & { gets: number; sets: number } {
  const inner = mapStore();
  const store = {
    gets: 0,
    sets: 0,
    get(k: string) {
      store.gets++;
      return inner.get(k);
    },
    set(k: string, v: string) {
      store.sets++;
      inner.set(k, v);
    },
    remove: inner.remove,
  };
  return store;
}

/** The site's recorded slice with its sunrise and sunset removed: it parses but covers no day. */
function noDaysSlice(id: string): RawSlice {
  const { launchRaw, neighborRaw } = fixtureSlice(id);
  const locs = JSON.parse(launchRaw) as Record<string, unknown>[];
  return { launchRaw: JSON.stringify(locs.map(({ daily: _, ...rest }) => rest)), neighborRaw };
}

describe("getRecommendations per site", () => {
  it("fetchesOnlyTheSitesWithoutAFreshEntry", async () => {
    const cache = newCache();
    seed(cache, NOW - 20 * MIN_MS, [GLENWOOD, BOULDER]);
    const stub = subsetTransport([BUTTE]);
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    // Crested Butte's launch only (the neighbor request also has its four offset points).
    expect(stub.urls.map(latitudes)[0]).toEqual(["38.8897"]);
    for (const url of stub.urls) {
      expect(url).not.toContain("39.5428");
      expect(url).not.toContain("40.0562");
    }
    expect(result.fetchedAt).toBe(NOW - 20 * MIN_MS);
    expect(result.isOffline).toBe(false);
    const open = result.sites.filter((r) => r.site.status.state === "open");
    expect(open.every((r) => (r.launches[0]?.daylight.length ?? 0) > 0)).toBe(true);
    // The fetched site is saved; the others are left as they were.
    expect([GLENWOOD, BUTTE, BOULDER].map((id) => cachedAt(cache, id))).toEqual([
      NOW - 20 * MIN_MS,
      NOW,
      NOW - 20 * MIN_MS,
    ]);
  });

  it("allFreshEntriesMakeNoRequestAndReportTheOldest", async () => {
    const cache = newCache();
    seed(cache, NOW - 50 * MIN_MS, [GLENWOOD]);
    seed(cache, NOW - 10 * MIN_MS, [BUTTE, BOULDER]);
    const stub = fixtureTransport();
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toEqual([]);
    expect(result.fetchedAt).toBe(NOW - 50 * MIN_MS);
  });

  it("refreshRefetchesOnlyEntriesFiveMinutesOldOrMore", async () => {
    const cache = newCache();
    seed(cache, NOW - 2 * MIN_MS, [GLENWOOD]);
    seed(cache, NOW - 4 * MIN_MS, [BUTTE]);
    seed(cache, NOW - 30 * MIN_MS, [BOULDER]);
    const stub = subsetTransport([BOULDER]);
    const result = await getRecommendations(request({ forceRefresh: true }), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.fetchedAt).toBe(NOW - 4 * MIN_MS);

    // With every entry under five minutes old, Refresh makes no request.
    const again = fixtureTransport();
    await getRecommendations(request({ forceRefresh: true }), deps(again, cache, NOW + MIN_MS / 2));
    expect(again.urls).toEqual([]);
  });

  it("aFailedFetchUsesEachSitesStaleEntryAndIsOffline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = newCache();
    seed(cache, NOW - 10 * MIN_MS, [GLENWOOD, BOULDER]);
    seed(cache, NOW - 3 * 60 * MIN_MS, [BUTTE]);
    const stub = throwingTransport();
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls.every((u) => latitudes(u).includes("38.8897"))).toBe(true);
    expect(result.isOffline).toBe(true);
    expect(result.fetchedAt).toBe(NOW - 3 * 60 * MIN_MS);
    const butte = result.sites.find((r) => r.site.id === BUTTE);
    expect(butte?.launches[0]?.daylight.length ?? 0).toBeGreaterThan(0);
    expect(cachedAt(cache, BUTTE)).toBe(NOW - 3 * 60 * MIN_MS);
  });

  it("aFailedFetchWithASiteMissingFromTheCacheThrows", async () => {
    const cache = newCache();
    seed(cache, NOW - 10 * MIN_MS, [GLENWOOD]);
    seed(cache, NOW - 3 * 60 * MIN_MS, [BOULDER]);
    await expect(getRecommendations(request(), deps(throwingTransport(), cache))).rejects.toThrow(
      "offline",
    );
  });

  it("aFreshEntryThatDoesntCoverTheDayIsRefetched", async () => {
    const cache = newCache();
    seed(cache, NOW - 10 * MIN_MS, [GLENWOOD, BOULDER]);
    seed(cache, NOW - MIN_MS, [BUTTE], mainKey, noDaysSlice);
    const stub = subsetTransport([BUTTE]);
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    const butte = result.sites.find((r) => r.site.id === BUTTE);
    expect(butte?.launches[0]?.daylight.length ?? 0).toBeGreaterThan(0);
    expect(cachedAt(cache, BUTTE)).toBe(NOW);
  });

  it("aFreshEntryWhoseSliceDoesntParseIsRefetched", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = newCache();
    seed(cache, NOW - 10 * MIN_MS, [GLENWOOD, BOULDER]);
    seed(cache, NOW - MIN_MS, [BUTTE], mainKey, () => ({ launchRaw: "[]", neighborRaw: "[]" }));
    const stub = subsetTransport([BUTTE]);
    const result = await getRecommendations(request(), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.fetchedAt).toBe(NOW - 10 * MIN_MS);
    expect(cachedAt(cache, BUTTE)).toBe(NOW);
  });

  it("mixedAgesGiveTheSameDayAndAgeWhicheverSitesAreCachedAndInAnyRequestOrder", async () => {
    // A minute after Boulder's sunset, before Glenwood's and Crested Butte's: Boulder's own default
    // day is Nov 8, the others' is Nov 7. Glenwood is first in the catalog, so the result is Nov 7.
    const now = BOULDER_SUNSET + MIN_MS;
    const outcomes = [];
    for (const [cached, fetched] of [
      [GLENWOOD, [BUTTE, BOULDER]],
      [BOULDER, [GLENWOOD, BUTTE]],
    ] as const) {
      for (const siteIds of [allIds(), [...allIds()].reverse()]) {
        const cache = newCache();
        seed(cache, now - 50 * MIN_MS, [cached]);
        const result = await getRecommendations(
          request({ siteIds }),
          deps(subsetTransport(fetched), cache, now),
        );
        const { day, dayOver, fetchedAt } = result;
        outcomes.push({ day, dayOver, fetchedAt });
      }
    }
    const expected = { day: "2026-11-07", dayOver: false, fetchedAt: now - 50 * MIN_MS };
    expect(outcomes).toEqual([expected, expected, expected, expected]);
  });

  it("aFarOutDayUsesDayEntriesAndLeavesMainEntriesAlone", async () => {
    const cache = newCache();
    // Fresh main entries that even cover Nov 7, but a far-out day never reads them.
    seed(cache, NOW_EARLIER - MIN_MS);
    const onDay = (id: string): string => dayKey("2026-11-07", id);
    seed(cache, NOW_EARLIER - 2 * MIN_MS, [GLENWOOD, BOULDER], onDay);
    const stub = subsetTransport([BUTTE], "2026-11-07");
    const result = await getRecommendations(request({ day: "2026-11-07" }), deps(stub, cache, NOW_EARLIER));
    expect(stub.urls).toHaveLength(2);
    expect(stub.urls.every((u) => u.includes("start_date=2026-11-07&end_date=2026-11-07"))).toBe(true);
    expect(result.fetchedAt).toBe(NOW_EARLIER - 2 * MIN_MS);
    expect(cachedAt(cache, BUTTE, onDay)).toBe(NOW_EARLIER);
    for (const { id } of openSites()) expect(cachedAt(cache, id)).toBe(NOW_EARLIER - MIN_MS);
  });

  it("aClosedSiteIsReturnedButNeverFetched", async () => {
    const cache = newCache();
    const stub = subsetTransport([BOULDER]);
    const result = await getRecommendations(request({ siteIds: [COPPER, BOULDER] }), deps(stub, cache));
    expect(stub.urls).toHaveLength(2);
    expect(result.sites.map((r) => r.site.id)).toEqual([BOULDER, COPPER]);
    expect(result.sites[1]?.launches).toEqual([]);
    expect(cachedAt(cache, COPPER)).toBeUndefined();
  });

  it("onlyTheRequestedSitesAreReturnedAndUnknownIdsAreIgnored", async () => {
    const stub = subsetTransport([BOULDER]);
    const result = await getRecommendations(
      request({ siteIds: ["nowhere/at-all", BOULDER, BOULDER] }),
      deps(stub, newCache()),
    );
    expect(stub.urls).toHaveLength(2);
    expect(result.sites.map((r) => r.site.id)).toEqual([BOULDER]);
    expect(result.fetchedAt).toBe(NOW);
  });

  it("noSiteIdsMeansNoRequestAndNoStorage", async () => {
    const store = countingStore();
    const cache = createSiteForecastCache(store);
    const stub = fixtureTransport();
    for (const day of [undefined, "2026-11-08"]) {
      const result = await getRecommendations(request({ siteIds: [], day }), deps(stub, cache));
      expect(result).toEqual({
        model: "ecmwf",
        day: day ?? "2026-11-07",
        today: "2026-11-07",
        dayOver: false,
        fetchedAt: NOW,
        isOffline: false,
        sites: [],
      });
    }
    expect(stub.urls).toEqual([]);
    expect(store.gets).toBe(0);
    expect(store.sets).toBe(0);
  });
});

describe("getRecommendations with RRFS primary", () => {
  /** The recorded launch response with every RRFS field nulled from Nov 8 00:00 MST (index 24). */
  function noRRFSOnNov8(): string {
    const locations = JSON.parse(launchesJSON) as { hourly: Record<string, unknown[]> }[];
    for (const { hourly } of locations) {
      for (const [key, values] of Object.entries(hourly)) {
        if (!key.endsWith("_ncep_rrfs_conus")) continue;
        for (let i = 24; i < values.length; i++) values[i] = null;
      }
    }
    return JSON.stringify(locations);
  }

  it("evaluatesEveryLaunchWithRRFSOnTheRecordedForecast", async () => {
    const forecasts = parseForecasts(launchesJSON, neighborsJSON, openLaunches());
    let windows = 0;
    let differsFromECMWF = false;
    for (const day of ["2026-11-07", "2026-11-08"]) {
      const result = await getRecommendations(request({ day, model: "rrfs" }), deps(fixtureTransport(), newCache()));
      expect(result.model).toBe("rrfs");
      const launches = result.sites.flatMap((rec) => rec.launches.map((l) => ({ site: rec.site, l })));
      expect(launches).toHaveLength(3);
      for (const { site: s, l } of launches) {
        expect(l.model).toBe("rrfs");
        expect(l.fellBack).toBe(false);
        const f = forecasts.find((x) => x.launchID === l.launch.id) ?? never();
        const evaluated = evaluateForecast(s, l.launch, f, "rrfs");
        const rrfs = byTime(evaluated.rrfs);
        const ecmwf = byTime(evaluated.ecmwf);
        expect(l.daylight.length).toBeGreaterThan(0);
        expect(l.daylight.map((row) => row.primary.result)).toEqual(l.daylight.map((row) => rrfs.get(row.time)));
        expect(l.daylight.map((row) => row.check?.result)).toEqual(l.daylight.map((row) => ecmwf.get(row.time)));
        const hours = l.window?.hours ?? [];
        expect(hours).toEqual(hours.map((h) => rrfs.get(h.time)));
        if (l.window !== undefined) windows += 1;
        if (hours.some((h) => h.score !== ecmwf.get(h.time)?.score)) differsFromECMWF = true;
      }
    }
    // The test can tell the models apart.
    expect(windows).toBeGreaterThan(0);
    expect(differsFromECMWF).toBe(true);
  });

  it("aDayRRFSDoesNotCoverFallsBackToECMWF", async () => {
    const body = noRRFSOnNov8();
    const day = "2026-11-08";
    const rrfs = await getRecommendations(request({ day, model: "rrfs" }), deps(fixtureTransport(body), newCache()));
    const ecmwf = await getRecommendations(request({ day, model: "ecmwf" }), deps(fixtureTransport(body), newCache()));
    expect(rrfs.model).toBe("rrfs");
    const launches = rrfs.sites.flatMap((rec) => rec.launches);
    expect(launches).toHaveLength(3);
    expect(launches.every((l) => l.model === "ecmwf" && l.fellBack)).toBe(true);
    // Apart from the flag, exactly the ECMWF choice.
    const unflagged = rrfs.sites.map((rec) => ({
      ...rec,
      launches: rec.launches.map((l) => ({ ...l, fellBack: false })),
    }));
    expect(unflagged).toEqual(ecmwf.sites);

    // Nov 7 still has RRFS, so it stays primary there.
    const nov7 = await getRecommendations(
      request({ day: "2026-11-07", model: "rrfs" }),
      deps(fixtureTransport(body), newCache()),
    );
    const nov7Launches = nov7.sites.flatMap((rec) => rec.launches);
    expect(nov7Launches).toHaveLength(3);
    expect(nov7Launches.every((l) => l.model === "rrfs" && !l.fellBack)).toBe(true);
  });

  it("aFreshCacheMeansNoFetchAndTheResultEchoesTheModel", async () => {
    const cache = newCache();
    seed(cache, NOW - 59 * MIN_MS);
    const stub = fixtureTransport();
    const result = await getRecommendations(request({ model: "rrfs" }), deps(stub, cache));
    expect(stub.urls).toEqual([]);
    expect(result.model).toBe("rrfs");
    expect(result.sites.flatMap((rec) => rec.launches).every((l) => l.model === "rrfs")).toBe(true);
  });

  it("echoesTheModelWithNoOpenSites", async () => {
    const stub = fixtureTransport();
    const result = await getRecommendations(request({ siteIds: [COPPER], model: "rrfs" }), deps(stub, newCache()));
    expect(stub.urls).toEqual([]);
    expect(result.model).toBe("rrfs");
  });
});

describe("resolveTargetDay", () => {
  it("uses the first forecast that has daylight days", () => {
    const [a, b] = parseForecasts(launchesJSON, neighborsJSON, openLaunches());
    if (a === undefined || b === undefined) never();
    expect(resolveTargetDay([{ ...a, days: [] }, b], NOW)).toBe("2026-11-07");
    expect(resolveTargetDay([{ ...a, days: [] }, { ...b, days: [] }], NOW)).toBeUndefined();
  });
});
