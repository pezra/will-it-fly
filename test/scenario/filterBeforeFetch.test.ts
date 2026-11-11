import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { launchRequestURL } from "../../src/core/forecast/openMeteoClient";
import type { Transport } from "../../src/core/forecast/openMeteoClient";
import type { KeyValueStore } from "../../src/core/keyValueStore";
import { createSiteForecastCache } from "../../src/core/forecast/siteForecastCache";
import type { SiteForecastCache } from "../../src/core/forecast/siteForecastCache";
import { firstLaunchCoordinate } from "../../src/core/recommendation/ranker";
import { getRecommendations } from "../../src/core/recommendation/recommendationService";
import type { RecommendationResult } from "../../src/core/recommendation/types";
import type { ModelName } from "../../src/core/scoring/hourEvaluator";
import type { Coordinate, Site, SiteKind } from "../../src/core/sites/site";
import { applyTravel } from "../../src/core/travel/applyTravel";
import type { TravelTimes } from "../../src/core/travel/applyTravel";
import { driveTimesFor, estimateDriveSeconds, startKey } from "../../src/core/travel/driveTime";
import {
  inRangeIds,
  mergeTimes,
  missingDestinations,
  travelStage,
  wantedSiteIds,
} from "../../src/core/travel/inRange";
import type { TravelStage } from "../../src/core/travel/inRange";
import type { DayKey } from "../../src/core/time";
import { SECONDS_PER_HOUR } from "../../src/core/units";
import { activeMode } from "../../src/ui/route";
import { maxSeconds } from "../../src/ui/travelSettings";
import type { KiteMinutes, MaxHours, TravelSettings } from "../../src/ui/travelSettings";
import { loadDecision, visibleState } from "../../src/ui/useRecommendations";
import type { RecommendationsState } from "../../src/ui/useRecommendations";
import { listView, travelCandidates } from "../../src/ui/useTravel";
import { mapStore, testLaunch, testSite } from "../support/builders";
import { BOULDER, BUTTE, COPPER, GLENWOOD, fixtureResponse, fixtureSites } from "../support/fixtureWeather";

/**
 * The whole pipeline without a DOM: prefilter, OSRM, in range, then weather, wired the way
 * `useTravel`, `useRecommendations` and `App` wire it, with fake OSRM and Open-Meteo transports
 * that record what they were asked. The candidates, the list view, the active mode and the load
 * decision come from the same pure functions the hooks use.
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
/** The same for `kitingCatalog`, with Boulder clear of the 30 min Kite radius. */
const KITE_ROUTED_HOURS: Record<string, number> = { ...ROUTED_HOURS, [BOULDER]: 0.4 };

/** The fixture sites and FAR, all flying. */
let flyingCatalog: Site[] = [];
/**
 * The same with Boulder a kiting site, the only one. Only the recorded launches have weather, so
 * a kiting site has to be one of them.
 */
let kitingCatalog: Site[] = [];

beforeAll(async () => {
  const far = testSite({
    id: FAR,
    launches: [testLaunch({ id: `${FAR}/main`, coordinate: { latitude: 39.2777, longitude: -108.9943 } })],
  });
  flyingCatalog = [...(await fixtureSites()), far];
  kitingCatalog = flyingCatalog.map((s): Site => (s.id === BOULDER ? { ...s, kind: "kiting" } : s));
});

afterEach(() => vi.restoreAllMocks());

/** A site's first launch. Both catalogs have the same launches. */
function first(id: string, sites: readonly Site[] = flyingCatalog): Coordinate {
  const coordinate = firstLaunchCoordinate(sites.find((s) => s.id === id) ?? testSite());
  if (coordinate === undefined) throw new Error(`no launch for ${id}`);
  return coordinate;
}

/** Travel settings with these radii. The start is passed to the pipeline on its own. */
function radii(maxHours: MaxHours, kiteMinutes: KiteMinutes = 30): TravelSettings {
  return { start: { kind: "geolocation" }, maxHours, kiteMinutes };
}

/** A destination as an OSRM table URL writes it. */
function pair(c: Coordinate): string {
  return `${c.longitude.toFixed(4)},${c.latitude.toFixed(4)}`;
}

/** Fake OSRM: answers from `hours` and records the site ids each request asked for. */
function fakeOSRM(
  sites: readonly Site[] = flyingCatalog,
  hours: Record<string, number> = ROUTED_HOURS,
): { transport: Transport; asked: string[][] } {
  const asked: string[][] = [];
  const byPair = new Map(Object.keys(hours).map((id) => [pair(first(id, sites)), id] as const));
  const transport: Transport = async (url) => {
    const path = url.slice(0, url.indexOf("?"));
    const dests = path.slice(path.lastIndexOf("/") + 1).split(";").slice(1);
    const ids = dests.map((d) => byPair.get(d) ?? `unknown ${d}`);
    asked.push(ids);
    const durations = ids.map((id) => (hours[id] ?? 0) * HOUR);
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
 * Fake Open-Meteo: serves the recorded slices for any subset of the recorded sites of `sites` and
 * fails anything else. `fetched` has the site ids of each launch request; `urls` every request.
 */
function countingWeather(sites: readonly Site[]): { transport: Transport; fetched: string[][]; urls: string[] } {
  const fetched: string[][] = [];
  const urls: string[] = [];
  const subsets = recordedSubsets();
  const transport: Transport = async (url) => {
    urls.push(url);
    for (const ids of subsets) {
      const body = fixtureResponse(sites, ids, url);
      if (body === undefined) continue;
      const launches = ids.flatMap((id) => sites.find((s) => s.id === id)?.launches ?? []);
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

interface PipelineOptions {
  /** The all-flying catalog unless given. */
  catalog?: Site[];
  /** A fake OSRM over the catalog with `ROUTED_HOURS` unless given. */
  osrm?: ReturnType<typeof fakeOSRM>;
  driveCache?: KeyValueStore;
}

/** The pipeline as the hooks run it, against fake transports and in-memory stores. */
class Pipeline {
  readonly catalog: Site[];
  readonly osrm: ReturnType<typeof fakeOSRM>;
  readonly weather: ReturnType<typeof countingWeather>;
  readonly driveCache: KeyValueStore;
  readonly forecastCache: SiteForecastCache = createSiteForecastCache(mapStore());
  now = NOW;
  /** The route's model, as `App` passes it to `useRecommendations`. */
  model: ModelName = "ecmwf";
  /** The list route's mode, as `App` passes it to `useTravel` and `useRecommendations`. */
  mode: SiteKind = "flying";
  /** `useTravel`'s merged drive times. */
  times: TravelTimes | undefined;
  /** `useRecommendations`' loaded result, with the day and mode it was asked for. */
  loaded: { day: DayKey | undefined; mode: SiteKind | undefined; result: RecommendationResult } | undefined;
  /** How many times `getRecommendations` ran. */
  loads = 0;
  private wanted: readonly string[] | undefined;
  private wantedMode: SiteKind | undefined;
  private day: DayKey | undefined;

  constructor({ catalog = flyingCatalog, osrm, driveCache = mapStore() }: PipelineOptions = {}) {
    this.catalog = catalog;
    this.osrm = osrm ?? fakeOSRM(catalog);
    this.weather = countingWeather(catalog);
    this.driveCache = driveCache;
  }

  /**
   * `useTravel` for `mode`: candidates, the drive-time effect (only missing ids), stage and
   * in-range ids.
   */
  async route(
    start: Coordinate | undefined,
    settings: TravelSettings,
    mode: SiteKind,
    locationPending = false,
  ): Promise<Routed> {
    const candidates = start === undefined ? undefined : travelCandidates(this.catalog, mode, start, settings);
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
        ? inRangeIds(candidates, this.times.times, maxSeconds(settings, mode))
        : [];
    return { stage, inRange };
  }

  /** `useRecommendations`' state: the loaded result, or loading. */
  state(): RecommendationsState {
    const loaded = this.loaded;
    return loaded === undefined
      ? { status: "loading" }
      : { status: "loaded", requested: loaded.day, mode: loaded.mode, result: loaded.result, refreshing: false };
  }

  /**
   * `useRecommendations` for the list's `mode` (undefined on a site page): reloads when the hook's
   * `loadDecision` says so (another day, model or mode, or a missing id), with no load in flight.
   * Refresh always loads.
   */
  async load(
    ids: readonly string[] | undefined,
    mode: SiteKind | undefined,
    day?: DayKey,
    forceRefresh = false,
  ): Promise<void> {
    this.wanted = ids;
    this.wantedMode = mode;
    this.day = day;
    if (ids === undefined) return;
    const model = this.model;
    if (!forceRefresh && loadDecision(this.state(), day, model, mode, ids, undefined) !== "load") return;
    this.loads++;
    const result = await getRecommendations(
      { forceRefresh, day, siteIds: ids, model },
      {
        siteProvider: { sites: async () => this.catalog },
        transport: this.weather.transport,
        cache: this.forecastCache,
        now: () => this.now,
      },
    );
    this.loaded = { day, mode, result };
  }

  /** `App` on the list page, in the route's mode. */
  async list(start: Coordinate | undefined, settings: TravelSettings, locationPending = false): Promise<Routed> {
    const routed = await this.route(start, settings, this.mode, locationPending);
    await this.load(
      wantedSiteIds({ page: "list", routeSiteId: undefined, stage: routed.stage, inRangeIds: routed.inRange }),
      this.mode,
    );
    return routed;
  }

  /**
   * `App` on a site page: travel runs in the site's own mode, and the weather load, which has no
   * mode, wants the site's own id at once, whatever the travel stage.
   */
  async site(id: string, start: Coordinate | undefined, settings: TravelSettings): Promise<void> {
    const routed = await this.route(start, settings, activeMode({ page: "site", id }, this.catalog));
    await this.load(
      wantedSiteIds({ page: "site", routeSiteId: id, stage: routed.stage, inRangeIds: routed.inRange }),
      undefined,
    );
  }

  /** The Refresh button: a forced load of the same ids. Travel is not touched. */
  refresh(): Promise<void> {
    return this.load(this.wanted, this.wantedMode, this.day, true);
  }

  /** `useTravelView` on the list: what it shows, how many of the mode's sites it hides, and of how many. */
  view(start: Coordinate, settings: TravelSettings): { shown: string[]; hiddenCount: number; total: number } {
    if (this.loaded === undefined) throw new Error("nothing loaded");
    const { shown } = applyTravel(this.loaded.result, start, this.times, maxSeconds(settings, this.mode));
    const view = listView(shown, this.mode, this.catalog, true);
    return { shown: view.shown.map((r) => r.site.id).sort(), hiddenCount: view.hiddenCount, total: view.total };
  }
}

/** A pipeline over `kitingCatalog`, where Boulder is the only kiting site. */
function kitePipeline(): Pipeline {
  return new Pipeline({ catalog: kitingCatalog, osrm: fakeOSRM(kitingCatalog, KITE_ROUTED_HOURS) });
}

describe("filter before fetch", () => {
  it("onlyInRangeSitesReachOpenMeteoAndOnlyPrefilteredOnesReachOSRM", async () => {
    const p = new Pipeline();
    const routed = await p.list(START, radii(2));

    expect(routed.stage).toBe("ready");
    expect(routed.inRange.sort()).toEqual([BOULDER, BUTTE, COPPER].sort());
    // FAR is past 160 mi, so it was never routed.
    expect(p.osrm.asked).toEqual([[GLENWOOD, BUTTE, BOULDER, COPPER]]);
    // Glenwood is routed over 2 h and Copper is closed: only Butte and Boulder get weather.
    expect(p.weather.fetched).toEqual([[BUTTE, BOULDER]]);
    expect(p.weather.urls).toHaveLength(2);
    const asked = latitudes(p.weather.urls[0] ?? "");
    for (const id of [GLENWOOD, COPPER, FAR]) expect(asked).not.toContain(first(id).latitude);
    expect(p.view(START, radii(2))).toEqual({ shown: [BOULDER, BUTTE, COPPER].sort(), hiddenCount: 2, total: 5 });
  });

  it("wideningRequestsOnlyTheNewSitesAndNarrowingRequestsNothing", async () => {
    const p = new Pipeline();
    await p.list(START, radii(2));
    p.osrm.asked.length = 0;
    p.weather.fetched.length = 0;
    p.weather.urls.length = 0;

    const wide = await p.list(START, radii(3));
    expect(wide.inRange).toContain(GLENWOOD);
    expect(p.osrm.asked).toEqual([[FAR]]);
    expect(p.weather.fetched).toEqual([[GLENWOOD]]);
    expect(p.weather.urls).toHaveLength(2);
    expect(p.view(START, radii(3))).toEqual({
      shown: [BOULDER, BUTTE, COPPER, GLENWOOD].sort(),
      hiddenCount: 1,
      total: 5,
    });

    const loads = p.loads;
    const narrow = await p.list(START, radii(2));
    expect(narrow.stage).toBe("ready");
    expect(narrow.inRange).not.toContain(GLENWOOD);
    expect(p.loads).toBe(loads);
    expect(p.osrm.asked).toHaveLength(1);
    expect(p.weather.urls).toHaveLength(2);
    expect(p.view(START, radii(2))).toEqual({ shown: [BOULDER, BUTTE, COPPER].sort(), hiddenCount: 2, total: 5 });
  });

  it("wideningRoutesOnlyTheNewSitesEvenWhenTheDriveTimeCacheKeepsNothing", async () => {
    // The merged map alone decides what to ask, not only `driveTimesFor`'s own cache.
    const p = new Pipeline({ driveCache: { get: () => undefined, set: () => undefined } });
    await p.list(START, radii(2));
    await p.list(START, radii(3));
    expect(p.osrm.asked).toEqual([[GLENWOOD, BUTTE, BOULDER, COPPER], [FAR]]);
    await p.list(START, radii(2));
    expect(p.osrm.asked).toHaveLength(2);
  });

  it("refreshWithinFiveMinutesRequestsNothingAndNeverCallsOSRM", async () => {
    const p = new Pipeline();
    await p.list(START, radii(2));
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

  it("switchingModelsReevaluatesFromTheCacheWithoutARequest", async () => {
    const p = new Pipeline();
    await p.list(START, radii(2));
    expect(p.loaded?.result.model).toBe("ecmwf");
    const loads = p.loads;
    const osrmCalls = p.osrm.asked.length;
    const weatherCalls = p.weather.urls.length;

    p.model = "rrfs";
    await p.list(START, radii(2));
    expect(p.loads).toBe(loads + 1);
    expect(p.loaded?.result.model).toBe("rrfs");
    const launches = p.loaded?.result.sites.flatMap((r) => r.launches) ?? [];
    expect(launches.length).toBeGreaterThan(0);
    expect(launches.every((l) => l.model === "rrfs" && !l.fellBack)).toBe(true);
    expect(p.weather.urls).toHaveLength(weatherCalls);
    expect(p.osrm.asked).toHaveLength(osrmCalls);

    // The same model again loads nothing; switching back loads ECMWF, still from the cache.
    await p.list(START, radii(2));
    expect(p.loads).toBe(loads + 1);
    p.model = "ecmwf";
    await p.list(START, radii(2));
    expect(p.loads).toBe(loads + 2);
    expect(p.loaded?.result.model).toBe("ecmwf");
    expect(p.weather.urls).toHaveLength(weatherCalls);
    expect(p.osrm.asked).toHaveLength(osrmCalls);
  });

  it("aDeadOSRMLeavesTheEstimatesDecidingTheRange", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = new Pipeline({ osrm: deadOSRM() });
    // At 40 mph: Boulder 0.1 h, Copper 1.5 h, Glenwood 2.8 h, Butte 3.0 h.
    expect(estimateDriveSeconds(START, first(COPPER))).toBeLessThan(1.6 * HOUR);
    expect(estimateDriveSeconds(START, first(GLENWOOD))).toBeGreaterThan(2.5 * HOUR);
    const routed = await p.list(START, radii(2));
    expect(routed.stage).toBe("ready");
    expect(routed.inRange.sort()).toEqual([BOULDER, COPPER].sort());
    expect(p.weather.fetched).toEqual([[BOULDER]]);
    expect(p.times?.times.get(BUTTE)?.source).toBe("estimate");
  });

  it("aSiteThePrefilterDropsIsNeverSentToOSRMOrOpenMeteo", async () => {
    const p = new Pipeline();
    await p.list(START, radii(1));
    await p.list(START, radii(2));
    expect(p.osrm.asked.flat()).not.toContain(FAR);
    expect(p.weather.urls.flatMap(latitudes)).not.toContain(first(FAR).latitude);
    // At 1 h, Glenwood and Butte were dropped too, and only routed once 2 h let them in.
    expect(p.osrm.asked).toEqual([[BOULDER, COPPER], [GLENWOOD, BUTTE]]);
  });

  it("aSitePageForAnExcludedSiteRequestsOnlyThatSite", async () => {
    const p = new Pipeline();
    await p.list(START, radii(1));
    expect(p.weather.fetched).toEqual([[BOULDER]]);

    await p.site(GLENWOOD, START, radii(1));
    expect(p.weather.fetched).toEqual([[BOULDER], [GLENWOOD]]);
    expect(p.osrm.asked.flat()).not.toContain(GLENWOOD);
    expect(p.loaded?.result.sites.map((r) => r.site.id)).toEqual([GLENWOOD]);
    // Its estimate is past the prefilter's bound, so the list would hide it.
    expect(p.view(START, radii(1)).shown).toEqual([]);
  });

  it("aSitePageWithNoStartLoadsItsSiteWithoutWaitingForLocation", async () => {
    const p = new Pipeline();
    const routed = await p.route(undefined, radii(2), "flying", true);
    expect(routed.stage).toBe("locating");
    await p.site(GLENWOOD, undefined, radii(2));
    expect(p.weather.fetched).toEqual([[GLENWOOD]]);
    expect(p.osrm.asked).toEqual([]);
  });

  it("aClosedInRangeSiteIsRoutedButNeverFetched", async () => {
    const p = new Pipeline();
    const routed = await p.list(START, radii(2));
    expect(p.osrm.asked.flat()).toContain(COPPER);
    expect(routed.inRange).toContain(COPPER);
    expect(p.weather.urls.flatMap(latitudes)).not.toContain(first(COPPER).latitude);
    const copper = p.loaded?.result.sites.find((r) => r.site.id === COPPER);
    expect(copper?.call).toBe("closed");
  });

  it("noStartMakesNoWeatherCall", async () => {
    const p = new Pipeline();
    expect((await p.list(undefined, radii(2), true)).stage).toBe("locating");
    expect((await p.list(undefined, radii(2))).stage).toBe("needsStart");
    expect(p.loads).toBe(0);
    expect(p.weather.urls).toEqual([]);
    expect(p.osrm.asked).toEqual([]);
  });

  it("nothingInRangeMakesNoRequestAndHidesEverySite", async () => {
    const p = new Pipeline();
    const nowhere: Coordinate = { latitude: 45, longitude: -95 };
    const routed = await p.list(nowhere, radii(1));
    expect(routed).toEqual({ stage: "ready", inRange: [] });
    expect(p.osrm.asked).toEqual([]);
    expect(p.weather.urls).toEqual([]);
    const all = flyingCatalog.length;
    expect(p.view(nowhere, radii(1))).toEqual({ shown: [], hiddenCount: all, total: all });
  });
});

describe("Fly and Kite modes", () => {
  it("flyNeverRoutesFetchesOrCountsAKitingSite", async () => {
    const p = kitePipeline();
    const routed = await p.list(START, radii(2));

    // Boulder is 3 mi away, but it's a kiting site.
    expect(routed).toEqual({ stage: "ready", inRange: [BUTTE, COPPER] });
    expect(p.osrm.asked).toEqual([[GLENWOOD, BUTTE, COPPER]]);
    expect(p.weather.fetched).toEqual([[BUTTE]]);
    expect(p.weather.urls.flatMap(latitudes)).not.toContain(first(BOULDER).latitude);
    // Four flying sites: Glenwood (2.5 h) and FAR are hidden, Boulder isn't counted.
    expect(p.view(START, radii(2))).toEqual({ shown: [BUTTE, COPPER].sort(), hiddenCount: 2, total: 4 });
  });

  it("switchingToKiteRoutesAndLoadsOnlyTheKitingSitesNotYetTimed", async () => {
    const p = kitePipeline();
    await p.list(START, radii(2));
    const loads = p.loads;

    p.mode = "kiting";
    const routed = await p.route(START, radii(2), "kiting");
    expect(p.osrm.asked).toEqual([[GLENWOOD, BUTTE, COPPER], [BOULDER]]);
    expect(routed).toEqual({ stage: "ready", inRange: [BOULDER] });
    // The Fly result is still the loaded one: the hook reloads, and shows loading until then.
    expect(loadDecision(p.state(), undefined, "ecmwf", "kiting", routed.inRange, undefined)).toBe("load");
    expect(visibleState(p.state(), undefined, "ecmwf", "kiting")).toEqual({ status: "loading" });

    await p.list(START, radii(2));
    expect(p.osrm.asked).toHaveLength(2);
    expect(p.loads).toBe(loads + 1);
    expect(p.weather.fetched).toEqual([[BUTTE], [BOULDER]]);
    expect(p.loaded?.result.sites.map((r) => r.site.id)).toEqual([BOULDER]);
    expect(p.view(START, radii(2))).toEqual({ shown: [BOULDER], hiddenCount: 0, total: 1 });
    // Boulder is routed at 24 min, so the 15 min radius hides it.
    expect(p.view(START, radii(2, 15))).toEqual({ shown: [], hiddenCount: 1, total: 1 });
  });

  it("switchingBackToFlyAsksOSRMNothingAndReevaluatesFromTheCache", async () => {
    const p = kitePipeline();
    await p.list(START, radii(2));
    p.mode = "kiting";
    await p.list(START, radii(2));
    const loads = p.loads;
    const osrmCalls = p.osrm.asked.length;
    const weatherCalls = p.weather.urls.length;

    p.mode = "flying";
    const routed = await p.route(START, radii(2), "flying");
    expect(routed).toEqual({ stage: "ready", inRange: [BUTTE, COPPER] });
    expect(loadDecision(p.state(), undefined, "ecmwf", "flying", routed.inRange, undefined)).toBe("load");

    await p.list(START, radii(2));
    expect(p.osrm.asked).toHaveLength(osrmCalls);
    expect(p.loads).toBe(loads + 1);
    expect(p.weather.urls).toHaveLength(weatherCalls);
    expect(p.view(START, radii(2))).toEqual({ shown: [BUTTE, COPPER].sort(), hiddenCount: 2, total: 4 });
  });

  it("aKitingSitesPageFromTheKiteListRoutesAndLoadsNothingNorDoesGoingBack", async () => {
    const p = kitePipeline();
    p.mode = "kiting";
    await p.list(START, radii(2));
    expect(p.osrm.asked).toEqual([[BOULDER]]);
    const loads = p.loads;

    // The page routes in the site's own mode, Kite, so the flying sites aren't routed.
    await p.site(BOULDER, START, radii(2));
    await p.list(START, radii(2));
    expect(p.osrm.asked).toEqual([[BOULDER]]);
    expect(p.loads).toBe(loads);
    expect(p.loaded?.mode).toBe("kiting");
  });
});
