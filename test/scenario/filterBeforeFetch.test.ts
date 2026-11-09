import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { launchRequestURL } from "../../src/core/forecast/openMeteoClient";
import type { Transport } from "../../src/core/forecast/openMeteoClient";
import type { KeyValueStore } from "../../src/core/keyValueStore";
import { createSiteForecastCache } from "../../src/core/forecast/siteForecastCache";
import type { SiteForecastCache } from "../../src/core/forecast/siteForecastCache";
import { firstLaunchCoordinate } from "../../src/core/recommendation/ranker";
import { getRecommendations } from "../../src/core/recommendation/recommendationService";
import type { RecommendationResult } from "../../src/core/recommendation/types";
import type { Coordinate, Site } from "../../src/core/sites/site";
import { applyTravel } from "../../src/core/travel/applyTravel";
import type { TravelTimes } from "../../src/core/travel/applyTravel";
import { driveTimesFor, estimateDriveSeconds, startKey, withinReach } from "../../src/core/travel/driveTime";
import {
  containsSites,
  inRangeIds,
  mergeTimes,
  missingDestinations,
  travelStage,
  wantedSiteIds,
} from "../../src/core/travel/inRange";
import type { TravelStage } from "../../src/core/travel/inRange";
import type { DayKey } from "../../src/core/time";
import { SECONDS_PER_HOUR } from "../../src/core/units";
import { mapStore, testLaunch, testSite } from "../support/builders";
import { BOULDER, BUTTE, COPPER, GLENWOOD, fixtureResponse, fixtureSites } from "../support/fixtureWeather";

/**
 * The whole pipeline without a DOM: prefilter, OSRM, in range, then weather, wired the way
 * `useTravel`, `useRecommendations` and `App` wire it, with fake OSRM and Open-Meteo transports
 * that record what they were asked.
 */

/** 2026-11-07 11:00 MST, inside the recorded forecast. */
const NOW = Date.UTC(2026, 10, 7, 18, 0, 0);
const MIN_MS = 60_000;
const HOUR = SECONDS_PER_HOUR;
const START: Coordinate = { latitude: 40.015, longitude: -105.27 };

/**
 * Straight-line miles from START: Boulder 3, Copper 60 (closed), Glenwood 113, Crested Butte 119,
 * FAR 205. So 1 h (80 mi) keeps Boulder and Copper, 2 h (160 mi) adds Glenwood and Butte, and only
 * 3 h (240 mi) reaches FAR.
 */
const FAR = "test/far";
/** Fake routed hours. Butte is in range at 2 h, Glenwood at 3 h, FAR never under 4 h. */
const ROUTED_HOURS: Record<string, number> = {
  [BOULDER]: 0.5,
  [COPPER]: 1.5,
  [BUTTE]: 1.8,
  [GLENWOOD]: 2.5,
  [FAR]: 3.5,
};

let catalog: Site[] = [];

beforeAll(async () => {
  const far = testSite({
    id: FAR,
    launches: [testLaunch({ id: `${FAR}/main`, coordinate: { latitude: 39.2777, longitude: -108.9943 } })],
  });
  catalog = [...(await fixtureSites()), far];
});

afterEach(() => vi.restoreAllMocks());

function first(id: string): Coordinate {
  const coordinate = firstLaunchCoordinate(catalog.find((s) => s.id === id) ?? testSite());
  if (coordinate === undefined) throw new Error(`no launch for ${id}`);
  return coordinate;
}

/** A destination as an OSRM table URL writes it. */
function pair(c: Coordinate): string {
  return `${c.longitude.toFixed(4)},${c.latitude.toFixed(4)}`;
}

/** Fake OSRM: answers from `ROUTED_HOURS` and records the site ids each request asked for. */
function fakeOSRM(): { transport: Transport; asked: string[][] } {
  const asked: string[][] = [];
  const byPair = new Map(Object.keys(ROUTED_HOURS).map((id) => [pair(first(id)), id] as const));
  const transport: Transport = async (url) => {
    const path = url.slice(0, url.indexOf("?"));
    const dests = path.slice(path.lastIndexOf("/") + 1).split(";").slice(1);
    const ids = dests.map((d) => byPair.get(d) ?? `unknown ${d}`);
    asked.push(ids);
    const durations = ids.map((id) => (ROUTED_HOURS[id] ?? 0) * HOUR);
    return { status: 200, body: JSON.stringify({ code: "Ok", durations: [durations] }) };
  };
  return { transport, asked };
}

function deadOSRM(): { transport: Transport; asked: string[][] } {
  const asked: string[][] = [];
  const transport: Transport = async () => {
    asked.push([]);
    throw new Error("offline");
  };
  return { transport, asked };
}

/** Every non-empty subset of the recorded sites, in catalog order. */
function recordedSubsets(): string[][] {
  const recorded = [GLENWOOD, BUTTE, BOULDER];
  const subsets: string[][] = [];
  for (let mask = 1; mask < 1 << recorded.length; mask++) {
    subsets.push(recorded.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return subsets;
}

/**
 * Fake Open-Meteo: serves the recorded slices for any subset of the recorded sites and fails
 * anything else. `fetched` has the site ids of each launch request; `urls` every request.
 */
function countingWeather(): { transport: Transport; fetched: string[][]; urls: string[] } {
  const fetched: string[][] = [];
  const urls: string[] = [];
  const subsets = recordedSubsets();
  const transport: Transport = async (url) => {
    urls.push(url);
    for (const ids of subsets) {
      const body = fixtureResponse(catalog, ids, url);
      if (body === undefined) continue;
      const launches = ids.flatMap((id) => catalog.find((s) => s.id === id)?.launches ?? []);
      if (url === launchRequestURL(launches)) fetched.push(ids);
      return { status: 200, body };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { transport, fetched, urls };
}

/** The `latitude=` values an Open-Meteo request asked for. */
function latitudes(url: string): number[] {
  return (new URL(url).searchParams.get("latitude") ?? "").split(",").map(Number);
}

interface Routed {
  stage: TravelStage;
  inRange: string[];
}

/** The pipeline as the hooks run it, against fake transports and in-memory stores. */
class Pipeline {
  readonly osrm: ReturnType<typeof fakeOSRM>;
  readonly weather = countingWeather();
  readonly driveCache: KeyValueStore;
  readonly forecastCache: SiteForecastCache = createSiteForecastCache(mapStore());
  now = NOW;
  /** `useTravel`'s merged drive times. */
  times: TravelTimes | undefined;
  /** `useRecommendations`' loaded result and the day it was asked for. */
  loaded: { day: DayKey | undefined; result: RecommendationResult } | undefined;
  /** How many times `getRecommendations` ran. */
  loads = 0;
  private wanted: readonly string[] | undefined;
  private day: DayKey | undefined;

  constructor(osrm = fakeOSRM(), driveCache: KeyValueStore = mapStore()) {
    this.osrm = osrm;
    this.driveCache = driveCache;
  }

  /** `useTravel`: candidates, the drive-time effect (only missing ids), stage and in-range ids. */
  async route(start: Coordinate | undefined, hours: number, locationPending = false): Promise<Routed> {
    const candidates = start === undefined ? undefined : withinReach(catalog, start, hours);
    if (start !== undefined && candidates !== undefined) {
      const key = startKey(start);
      const missing = missingDestinations(candidates, this.times, key);
      const fetched =
        missing.length === 0
          ? new Map()
          : await driveTimesFor(start, missing, { transport: this.osrm.transport, cache: this.driveCache });
      this.times = mergeTimes(this.times, key, fetched);
    }
    const stage = travelStage({ start, locationPending, candidates, times: this.times });
    const inRange =
      stage === "ready" && candidates !== undefined && this.times !== undefined
        ? inRangeIds(candidates, this.times.times, hours * HOUR)
        : [];
    return { stage, inRange };
  }

  /** `useRecommendations`: reloads unless the loaded result already has every id for the day. */
  async load(ids: readonly string[] | undefined, day?: DayKey, forceRefresh = false): Promise<void> {
    this.wanted = ids;
    this.day = day;
    if (ids === undefined) return;
    const loaded = this.loaded;
    if (!forceRefresh && loaded !== undefined && loaded.day === day && containsSites(loaded.result, ids)) {
      return;
    }
    this.loads++;
    const result = await getRecommendations(
      { forceRefresh, day, siteIds: ids, model: "ecmwf" },
      {
        siteProvider: { sites: async () => catalog },
        transport: this.weather.transport,
        cache: this.forecastCache,
        now: () => this.now,
      },
    );
    this.loaded = { day, result };
  }

  /** `App` on the list page. */
  async list(start: Coordinate | undefined, hours: number, locationPending = false): Promise<Routed> {
    const routed = await this.route(start, hours, locationPending);
    await this.load(
      wantedSiteIds({ page: "list", routeSiteId: undefined, stage: routed.stage, inRangeIds: routed.inRange }),
    );
    return routed;
  }

  /** `App` on a site page: the site's own id at once, whatever the travel stage. */
  async site(id: string, start: Coordinate | undefined, hours: number): Promise<void> {
    const routed = await this.route(start, hours);
    await this.load(wantedSiteIds({ page: "site", routeSiteId: id, stage: routed.stage, inRangeIds: routed.inRange }));
  }

  /** The Refresh button: a forced load of the same ids. Travel is not touched. */
  refresh(): Promise<void> {
    return this.load(this.wanted, this.day, true);
  }

  /** `useTravelView`: what the list shows and how many catalog sites it hides. */
  view(start: Coordinate, hours: number): { shown: string[]; hiddenCount: number } {
    if (this.loaded === undefined) throw new Error("nothing loaded");
    const { shown } = applyTravel(this.loaded.result, start, this.times, hours * HOUR);
    return { shown: shown.map((r) => r.site.id).sort(), hiddenCount: catalog.length - shown.length };
  }
}

describe("filter before fetch", () => {
  it("onlyInRangeSitesReachOpenMeteoAndOnlyPrefilteredOnesReachOSRM", async () => {
    const p = new Pipeline();
    const routed = await p.list(START, 2);

    expect(routed.stage).toBe("ready");
    expect(routed.inRange.sort()).toEqual([BOULDER, BUTTE, COPPER].sort());
    // FAR is past 160 mi, so it was never routed.
    expect(p.osrm.asked).toEqual([[GLENWOOD, BUTTE, BOULDER, COPPER]]);
    // Glenwood is routed over 2 h and Copper is closed: only Butte and Boulder get weather.
    expect(p.weather.fetched).toEqual([[BUTTE, BOULDER]]);
    expect(p.weather.urls).toHaveLength(2);
    const asked = latitudes(p.weather.urls[0] ?? "");
    for (const id of [GLENWOOD, COPPER, FAR]) expect(asked).not.toContain(first(id).latitude);
    expect(p.view(START, 2)).toEqual({ shown: [BOULDER, BUTTE, COPPER].sort(), hiddenCount: 2 });
  });

  it("wideningRequestsOnlyTheNewSitesAndNarrowingRequestsNothing", async () => {
    const p = new Pipeline();
    await p.list(START, 2);
    p.osrm.asked.length = 0;
    p.weather.fetched.length = 0;
    p.weather.urls.length = 0;

    const wide = await p.list(START, 3);
    expect(wide.inRange).toContain(GLENWOOD);
    expect(p.osrm.asked).toEqual([[FAR]]);
    expect(p.weather.fetched).toEqual([[GLENWOOD]]);
    expect(p.weather.urls).toHaveLength(2);
    expect(p.view(START, 3)).toEqual({ shown: [BOULDER, BUTTE, COPPER, GLENWOOD].sort(), hiddenCount: 1 });

    const loads = p.loads;
    const narrow = await p.list(START, 2);
    expect(narrow.stage).toBe("ready");
    expect(narrow.inRange).not.toContain(GLENWOOD);
    expect(p.loads).toBe(loads);
    expect(p.osrm.asked).toHaveLength(1);
    expect(p.weather.urls).toHaveLength(2);
    expect(p.view(START, 2)).toEqual({ shown: [BOULDER, BUTTE, COPPER].sort(), hiddenCount: 2 });
  });

  it("wideningRoutesOnlyTheNewSitesEvenWhenTheDriveTimeCacheKeepsNothing", async () => {
    // The merged map alone decides what to ask, not only `driveTimesFor`'s own cache.
    const p = new Pipeline(fakeOSRM(), { get: () => undefined, set: () => undefined });
    await p.list(START, 2);
    await p.list(START, 3);
    expect(p.osrm.asked).toEqual([[GLENWOOD, BUTTE, BOULDER, COPPER], [FAR]]);
    await p.list(START, 2);
    expect(p.osrm.asked).toHaveLength(2);
  });

  it("refreshWithinFiveMinutesRequestsNothingAndNeverCallsOSRM", async () => {
    const p = new Pipeline();
    await p.list(START, 2);
    const osrmCalls = p.osrm.asked.length;
    const weatherCalls = p.weather.urls.length;

    p.now = NOW + 4 * MIN_MS;
    await p.refresh();
    expect(p.weather.urls).toHaveLength(weatherCalls);

    // After five minutes Refresh refetches the same sites, still without routing.
    p.now = NOW + 6 * MIN_MS;
    await p.refresh();
    expect(p.weather.fetched.at(-1)).toEqual([BUTTE, BOULDER]);
    expect(p.osrm.asked).toHaveLength(osrmCalls);
  });

  it("aDeadOSRMLeavesTheEstimatesDecidingTheRange", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = new Pipeline(deadOSRM());
    // At 40 mph: Boulder 0.1 h, Copper 1.5 h, Glenwood 2.8 h, Butte 3.0 h.
    expect(estimateDriveSeconds(START, first(COPPER))).toBeLessThan(1.6 * HOUR);
    expect(estimateDriveSeconds(START, first(GLENWOOD))).toBeGreaterThan(2.5 * HOUR);
    const routed = await p.list(START, 2);
    expect(routed.stage).toBe("ready");
    expect(routed.inRange.sort()).toEqual([BOULDER, COPPER].sort());
    expect(p.weather.fetched).toEqual([[BOULDER]]);
    expect(p.times?.times.get(BUTTE)?.source).toBe("estimate");
  });

  it("aSiteThePrefilterDropsIsNeverSentToOSRMOrOpenMeteo", async () => {
    const p = new Pipeline();
    await p.list(START, 1);
    await p.list(START, 2);
    expect(p.osrm.asked.flat()).not.toContain(FAR);
    expect(p.weather.urls.flatMap(latitudes)).not.toContain(first(FAR).latitude);
    // At 1 h, Glenwood and Butte were dropped too, and only routed once 2 h let them in.
    expect(p.osrm.asked).toEqual([[BOULDER, COPPER], [GLENWOOD, BUTTE]]);
  });

  it("aSitePageForAnExcludedSiteRequestsOnlyThatSite", async () => {
    const p = new Pipeline();
    await p.list(START, 1);
    expect(p.weather.fetched).toEqual([[BOULDER]]);

    await p.site(GLENWOOD, START, 1);
    expect(p.weather.fetched).toEqual([[BOULDER], [GLENWOOD]]);
    expect(p.osrm.asked.flat()).not.toContain(GLENWOOD);
    expect(p.loaded?.result.sites.map((r) => r.site.id)).toEqual([GLENWOOD]);
    // Its estimate is past the prefilter's bound, so the list would hide it.
    expect(p.view(START, 1).shown).toEqual([]);
  });

  it("aSitePageWithNoStartLoadsItsSiteWithoutWaitingForLocation", async () => {
    const p = new Pipeline();
    const routed = await p.route(undefined, 2, true);
    expect(routed.stage).toBe("locating");
    await p.site(GLENWOOD, undefined, 2);
    expect(p.weather.fetched).toEqual([[GLENWOOD]]);
    expect(p.osrm.asked).toEqual([]);
  });

  it("aClosedInRangeSiteIsRoutedButNeverFetched", async () => {
    const p = new Pipeline();
    const routed = await p.list(START, 2);
    expect(p.osrm.asked.flat()).toContain(COPPER);
    expect(routed.inRange).toContain(COPPER);
    expect(p.weather.urls.flatMap(latitudes)).not.toContain(first(COPPER).latitude);
    const copper = p.loaded?.result.sites.find((r) => r.site.id === COPPER);
    expect(copper?.call).toBe("closed");
  });

  it("noStartMakesNoWeatherCall", async () => {
    const p = new Pipeline();
    expect((await p.list(undefined, 2, true)).stage).toBe("locating");
    expect((await p.list(undefined, 2)).stage).toBe("needsStart");
    expect(p.loads).toBe(0);
    expect(p.weather.urls).toEqual([]);
    expect(p.osrm.asked).toEqual([]);
  });

  it("nothingInRangeMakesNoRequestAndHidesEverySite", async () => {
    const p = new Pipeline();
    const nowhere: Coordinate = { latitude: 45, longitude: -95 };
    const routed = await p.list(nowhere, 1);
    expect(routed).toEqual({ stage: "ready", inRange: [] });
    expect(p.osrm.asked).toEqual([]);
    expect(p.weather.urls).toEqual([]);
    expect(p.view(nowhere, 1)).toEqual({ shown: [], hiddenCount: catalog.length });
  });
});
