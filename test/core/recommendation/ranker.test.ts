import { describe, expect, it } from "vitest";
import {
  bestWindow,
  mainReason,
  rankSites,
  recommendSite,
  withDistances,
} from "../../../src/core/recommendation/ranker";
import type {
  LaunchEvaluation,
  ModelRow,
  RecommendationResult,
  SiteRecommendation,
} from "../../../src/core/recommendation/types";
import { REASON_KIND_ORDER, REASON_SEVERITY } from "../../../src/core/scoring/hourEvaluator";
import type { HourResult, ModelName, ReasonKind } from "../../../src/core/scoring/hourEvaluator";
import type { FlyingWindow } from "../../../src/core/scoring/windowFinder";
import type { Launch, Site } from "../../../src/core/sites/site";
import { distanceM } from "../../../src/core/sites/coordinate";
import { testLaunch, testSite } from "../../support/builders";

const HOUR_MS = 3_600_000;
const T0 = 1_784_138_400_000;

function launch(id: string, latitude = 39.5, longitude = -106): Launch {
  return testLaunch({ id, name: id, coordinate: { latitude, longitude }, elevationFt: 8000 });
}

function site(name: string, o: { closed?: boolean; launches?: Launch[] } = {}): Site {
  return testSite({
    id: `test/${name}`,
    name,
    status: o.closed === true ? { state: "closed", reason: "closed" } : { state: "open" },
    launches: o.launches ?? [launch(`test/${name}/main`)],
    limits: { minMph: 0, maxMph: 15 },
  });
}

function window(score: number, hours: HourResult[] = []): FlyingWindow {
  return { start: T0, end: T0 + HOUR_MS, hours, score, confidence: "high", warnings: [], conditions: [], cautions: [] };
}

function rec(
  name: string,
  o: { score?: number; distance?: number; closed?: boolean; flyable?: boolean } = {},
): SiteRecommendation {
  const s = site(name, o.closed === undefined ? {} : { closed: o.closed });
  const first = s.launches[0] as Launch;
  return {
    site: s,
    call:
      o.closed === true ? "closed" : o.score === undefined ? "noGo" : o.flyable === true ? "flyable" : "good",
    distanceM: o.distance,
    best: o.score === undefined ? undefined : { launch: first, model: "ecmwf", window: window(o.score) },
    launches: [],
  };
}

const names = (recs: readonly SiteRecommendation[]): string[] => recs.map((r) => r.site.name);

describe("rankSites", () => {
  it("ordersWindowsThenNoWindowThenClosed", () => {
    const ranked = rankSites([
      rec("closedB", { closed: true }),
      rec("none", { distance: 1 }),
      rec("low", { score: 40, distance: 1 }),
      rec("closedA", { closed: true, distance: 1 }),
      rec("high", { score: 80, distance: 99 }),
    ]);
    expect(names(ranked)).toEqual(["high", "low", "none", "closedA", "closedB"]);
  });

  it("breaksWindowScoreTiesByDistanceWithUndefinedLast", () => {
    const ranked = rankSites([
      rec("unknown", { score: 50 }),
      rec("far", { score: 50, distance: 30_000 }),
      rec("near", { score: 50, distance: 10_000 }),
    ]);
    expect(names(ranked)).toEqual(["near", "far", "unknown"]);
  });

  it("ordersNoWindowSitesByDistanceWithUndefinedLast", () => {
    const ranked = rankSites([
      rec("unknown"),
      rec("far", { distance: 30_000 }),
      rec("near", { distance: 10_000 }),
    ]);
    expect(names(ranked)).toEqual(["near", "far", "unknown"]);
  });

  it("keepsInputOrderForFullTiesAndDoesNotMutate", () => {
    const input = [rec("a", { score: 50 }), rec("b", { score: 50 }), rec("c", { score: 50 })];
    expect(names(rankSites(input))).toEqual(["a", "b", "c"]);
    expect(names(input)).toEqual(["a", "b", "c"]);
  });

  it("goodSitesComeBeforeHigherScoringFlyableSites", () => {
    const ranked = rankSites([
      rec("none"),
      rec("flyable", { score: 90, flyable: true }),
      rec("good", { score: 40 }),
      rec("flyable2", { score: 95, flyable: true }),
    ]);
    expect(names(ranked)).toEqual(["good", "flyable2", "flyable", "none"]);
  });

  it("closedSitesAreOrderedByNameIgnoringDistance", () => {
    const ranked = rankSites([
      rec("Zeta", { closed: true, distance: 1 }),
      rec("Alpha", { closed: true, distance: 99 }),
    ]);
    expect(names(ranked)).toEqual(["Alpha", "Zeta"]);
  });
});

describe("withDistances", () => {
  const result = (sites: SiteRecommendation[]): RecommendationResult => ({
    model: "ecmwf",
    day: "2026-11-08",
    today: "2026-11-08",
    dayOver: false,
    fetchedAt: T0,
    isOffline: false,
    sites,
  });

  it("fillsDistancesFromTheFirstLaunchAndResortsTies", () => {
    const farSite = { ...rec("far", { score: 50 }), site: site("far", { launches: [launch("f", 40.5, -105)] }) };
    const nearSite = { ...rec("near", { score: 50 }), site: site("near", { launches: [launch("n", 39.6, -106)] }) };
    // Without a location, the tie keeps the input order: far first.
    const before = result(rankSites([farSite, nearSite]));
    expect(names(before.sites)).toEqual(["far", "near"]);
    const where = { latitude: 39.5, longitude: -106 };
    const after = withDistances(before, where);
    expect(names(after.sites)).toEqual(["near", "far"]);
    expect(after.sites[0]?.distanceM).toBeCloseTo(distanceM(where, { latitude: 39.6, longitude: -106 }), 3);
    expect(after.day).toBe("2026-11-08");
    expect(after.fetchedAt).toBe(T0);
    expect(before.sites[0]?.distanceM).toBeUndefined();
  });

  it("windowScoreStillOutranksDistance", () => {
    const where = { latitude: 39.5, longitude: -106 };
    const good = { ...rec("good", { score: 90 }), site: site("good", { launches: [launch("g", 41, -104)] }) };
    const near = { ...rec("near", { score: 10 }), site: site("near", { launches: [launch("n", 39.5, -106)] }) };
    expect(names(withDistances(result([near, good]), where).sites)).toEqual(["good", "near"]);
  });

  it("removingTheLocationClearsDistances", () => {
    const withIt = withDistances(result([rec("a", { score: 1 })]), { latitude: 39, longitude: -106 });
    expect(withIt.sites[0]?.distanceM).toBeDefined();
    expect(withDistances(withIt, undefined).sites[0]?.distanceM).toBeUndefined();
  });
});

function hourResult(time: number, kinds: ReasonKind[], call: HourResult["call"] = "noGo"): HourResult {
  return {
    time,
    call,
    score: 0,
    unpenalizedScore: 0,
    conditions: [],
    reasons: kinds.map((kind) => ({ kind, severity: REASON_SEVERITY[kind], text: `text ${kind}` })),
  };
}

const modelRow = (result: HourResult): ModelRow => ({ result, hour: { time: result.time, levels: {} } });

function evaluation(
  id: string,
  daylight: HourResult[],
  windowScore?: number,
  windowHours: HourResult[] = [],
  model: ModelName = "ecmwf",
): LaunchEvaluation {
  return {
    launch: launch(id),
    model,
    fellBack: false,
    daylight: daylight.map((result) => ({ time: result.time, primary: modelRow(result) })),
    window: windowScore === undefined ? undefined : window(windowScore, windowHours),
  };
}

describe("bestWindow", () => {
  it("aMultiLaunchSiteTakesItsBestLaunch", () => {
    const best = bestWindow([evaluation("a", [], 40), evaluation("b", [], 70), evaluation("c", [])]);
    expect(best?.launch.id).toBe("b");
    expect(best?.window.score).toBe(70);
  });

  it("whenLaunchWindowsTieTheFirstLaunchInTheJSONWins", () => {
    const best = bestWindow([evaluation("first", [], 55), evaluation("second", [], 55)]);
    expect(best?.launch.id).toBe("first");
  });

  it("carriesTheBestLaunchsModel", () => {
    const best = bestWindow([
      evaluation("ecmwf", [], 40, [], "ecmwf"),
      evaluation("rrfs", [], 70, [], "rrfs"),
    ]);
    expect(best?.launch.id).toBe("rrfs");
    expect(best?.model).toBe("rrfs");
    expect(bestWindow([evaluation("a", [], 40, [], "rrfs"), evaluation("b", [], 70, [], "ecmwf")])?.model).toBe(
      "ecmwf",
    );
  });

  it("noWindowsGivesUndefined", () => {
    expect(bestWindow([evaluation("a", [])])).toBeUndefined();
    expect(bestWindow([])).toBeUndefined();
  });
});

describe("mainReason", () => {
  it("isTheMostFrequentNoGoKindAcrossAllLaunches", () => {
    const a = evaluation("a", [
      hourResult(T0, ["precipitation"]),
      hourResult(T0 + HOUR_MS, ["precipitation", "windTooStrong"]),
    ]);
    const b = evaluation("b", [
      hourResult(T0, ["windTooStrong"]),
      hourResult(T0 + HOUR_MS, ["windTooStrong"]),
    ]);
    // precipitation 2, windTooStrong 3.
    expect(mainReason([a, b])).toEqual({
      kind: "windTooStrong",
      severity: "noGo",
      text: "text windTooStrong",
    });
  });

  it("breaksCountTiesByReasonKindOrder", () => {
    const hours = [hourResult(T0, ["wrongDirection"]), hourResult(T0 + HOUR_MS, ["precipitation"])];
    expect(REASON_KIND_ORDER.indexOf("precipitation")).toBeLessThan(
      REASON_KIND_ORDER.indexOf("wrongDirection"),
    );
    expect(mainReason([evaluation("a", hours)]).kind).toBe("precipitation");
  });

  it("noGoOutranksAMoreFrequentCautionKind", () => {
    const hours = [
      hourResult(T0, ["overdevelopment"], "flyable"),
      hourResult(T0 + HOUR_MS, ["overdevelopment"], "flyable"),
      hourResult(T0 + 2 * HOUR_MS, ["windTooWeak"]),
    ];
    expect(mainReason([evaluation("a", hours)]).kind).toBe("windTooWeak");
  });

  it("fallsBackToTheMostFrequentCautionKind", () => {
    const hours = [
      hourResult(T0, ["lowCloud", "sledder", "capeUnavailable"], "flyable"),
      hourResult(T0 + HOUR_MS, ["lowCloud", "sledder", "overdevelopment"], "flyable"),
      hourResult(T0 + 2 * HOUR_MS, ["overdevelopment", "sledder", "capeUnavailable"], "flyable"),
    ];
    // overdevelopment 2, lowCloud 2: overdevelopment is declared first. Penalty and info kinds
    // are ignored.
    expect(mainReason([evaluation("a", hours)])).toEqual({
      kind: "overdevelopment",
      severity: "caution",
      text: "text overdevelopment",
    });
  });

  it("saysNoFlyableHourWhenThereIsNothingToCount", () => {
    const quiet = evaluation("a", [hourResult(T0, ["capeUnavailable"], "flyable")]);
    expect(mainReason([quiet])).toEqual({
      kind: "noFlyableHour",
      severity: "info",
      text: "no flyable hour",
    });
    expect(mainReason([]).kind).toBe("noFlyableHour");
  });

  it("ignoresWarnings", () => {
    const gusty = evaluation("a", [
      hourResult(T0, ["highGusts"], "flyable"),
      hourResult(T0 + HOUR_MS, ["highGusts", "lowCloud"], "flyable"),
    ]);
    expect(mainReason([gusty]).kind).toBe("lowCloud");
    const onlyWarnings = evaluation("a", [hourResult(T0, ["highGusts"], "good")]);
    expect(mainReason([onlyWarnings]).kind).toBe("noFlyableHour");
  });

  it("countsOnlyThePrimaryModelsReasons", () => {
    // The check side has more no-go hours, of a kind declared earlier. Reading it would give
    // precipitation.
    const rows = [0, 1, 2].map((k) => ({
      time: T0 + k * HOUR_MS,
      primary: modelRow(hourResult(T0 + k * HOUR_MS, k === 0 ? ["windTooStrong"] : [], k === 0 ? "noGo" : "flyable")),
      check: modelRow(hourResult(T0 + k * HOUR_MS, ["precipitation"])),
    }));
    for (const model of ["ecmwf", "rrfs"] as const) {
      const e: LaunchEvaluation = { launch: launch("a"), model, fellBack: false, daylight: rows, window: undefined };
      expect(mainReason([e])).toEqual({ kind: "windTooStrong", severity: "noGo", text: "text windTooStrong" });
    }
  });

  it("noDataCountsAsANoGoKind", () => {
    expect(mainReason([evaluation("a", [hourResult(T0, ["noData"], "noData")])]).kind).toBe("noData");
  });
});

describe("recommendSite", () => {
  it("anOpenSiteWithAWindowHasBestAndNoMainReason", () => {
    const s = site("s");
    const r = recommendSite(s, [evaluation("x", [], 60)]);
    expect(r.best?.window.score).toBe(60);
    expect(r.mainReason).toBeUndefined();
    expect(r.distanceM).toBeUndefined();
  });

  it("anOpenSiteWithoutAWindowHasAMainReason", () => {
    const r = recommendSite(site("s"), [evaluation("x", [hourResult(T0, ["precipitation"])])]);
    expect(r.best).toBeUndefined();
    expect(r.mainReason?.kind).toBe("precipitation");
  });

  it("anOffDirectionNeighborCanBeTheMainReason", () => {
    const hours = [
      hourResult(T0, ["neighborOffDirectionStrong"]),
      hourResult(T0 + HOUR_MS, ["neighborOffDirectionStrong", "neighborOffDirection"]),
      hourResult(T0 + 2 * HOUR_MS, ["windTooWeak"]),
    ];
    const r = recommendSite(site("s"), [evaluation("x", hours)]);
    expect(r.best).toBeUndefined();
    expect(r.mainReason).toEqual({
      kind: "neighborOffDirectionStrong",
      severity: "noGo",
      text: "text neighborOffDirectionStrong",
    });
  });

  it("aClosedSiteHasNoLaunchesBestOrReason", () => {
    const where = { latitude: 39.5, longitude: -106 };
    const r = recommendSite(site("s", { closed: true }), [evaluation("x", [], 99)]);
    expect(r.launches).toEqual([]);
    expect(r.best).toBeUndefined();
    expect(r.mainReason).toBeUndefined();
    expect(r.call).toBe("closed");
    const result: RecommendationResult = {
      model: "ecmwf",
      day: "2026-11-08",
      today: "2026-11-08",
      dayOver: false,
      fetchedAt: 0,
      isOffline: false,
      sites: [r],
    };
    expect(withDistances(result, where).sites[0]?.distanceM).toBe(0);
  });

  it("callsTheSiteGoodWhenTheWindowHasAGoodHour", () => {
    const good = hourResult(T0, [], "good");
    const flyable = hourResult(T0 + HOUR_MS, ["nearMaxWind"], "flyable");
    const s = site("s");
    expect(recommendSite(s, [evaluation("x", [], 60, [good])]).call).toBe("good");
    expect(recommendSite(s, [evaluation("x", [], 60, [good, flyable])]).call).toBe("good");
    expect(recommendSite(s, [evaluation("x", [], 60, [flyable])]).call).toBe("flyable");
    expect(recommendSite(s, [evaluation("x", [hourResult(T0, ["precipitation"])])]).call).toBe("noGo");
  });

  it("ranksByTheCall", () => {
    const open = (name: string, hours: HourResult[] | undefined): SiteRecommendation =>
      recommendSite(site(name), hours === undefined ? [] : [evaluation(name, [], 50, hours)]);
    const closed = recommendSite(site("closed", { closed: true }), []);
    const ranked = rankSites([closed, open("none", undefined), open("flyable", [hourResult(T0, ["lowCloud"], "flyable")])]);
    expect(names(ranked)).toEqual(["flyable", "none", "closed"]);
  });
});
