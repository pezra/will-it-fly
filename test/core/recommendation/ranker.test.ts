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
  RecommendationResult,
  SiteRecommendation,
} from "../../../src/core/recommendation/types";
import { REASON_KIND_ORDER, REASON_SEVERITY } from "../../../src/core/scoring/hourEvaluator";
import type { HourResult, ReasonKind } from "../../../src/core/scoring/hourEvaluator";
import type { FlyingWindow } from "../../../src/core/scoring/windowFinder";
import type { Launch, Site } from "../../../src/core/sites/site";
import { distanceM } from "../../../src/core/sites/coordinate";

const HOUR_MS = 3_600_000;
const T0 = 1_784_138_400_000;

function launch(id: string, latitude = 39.5, longitude = -106): Launch {
  return {
    id,
    name: id,
    coordinate: { latitude, longitude },
    elevationFt: 8000,
    directions: { ok: [], ideal: [] },
  };
}

function site(name: string, o: { closed?: boolean; launches?: Launch[] } = {}): Site {
  return {
    id: `test/${name}`,
    name,
    sourceURL: "https://example.com",
    rating: "P2",
    status: o.closed === true ? { state: "closed", reason: "closed" } : { state: "open" },
    launches: o.launches ?? [launch(`test/${name}/main`)],
    limits: { minMph: 0, maxMph: 15 },
  };
}

function window(score: number): FlyingWindow {
  return { start: T0, end: T0 + HOUR_MS, hours: [], score, confidence: "high" };
}

function rec(
  name: string,
  o: { score?: number; distance?: number; closed?: boolean } = {},
): SiteRecommendation {
  const s = site(name, o.closed === undefined ? {} : { closed: o.closed });
  const first = s.launches[0] as Launch;
  return {
    site: s,
    distanceM: o.distance,
    best: o.score === undefined ? undefined : { launch: first, window: window(o.score) },
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
    day: "today",
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
    expect(after.day).toBe("today");
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
    reasons: kinds.map((kind) => ({ kind, severity: REASON_SEVERITY[kind], text: `text ${kind}` })),
  };
}

function evaluation(
  id: string,
  daylight: HourResult[],
  windowScore?: number,
): LaunchEvaluation {
  return {
    launch: launch(id),
    ecmwfHours: [],
    rrfsHours: [],
    ecmwf: daylight,
    rrfs: [],
    daylight,
    window: windowScore === undefined ? undefined : window(windowScore),
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

  it("noWindowsGivesUndefined", () => {
    expect(bestWindow([evaluation("a", [])])).toBeUndefined();
    expect(bestWindow([])).toBeUndefined();
  });
});

describe("mainReason", () => {
  it("isTheMostFrequentNoGoKindAcrossAllLaunches", () => {
    const a = evaluation("a", [
      hourResult(T0, ["gusts"]),
      hourResult(T0 + HOUR_MS, ["gusts", "windTooStrong"]),
    ]);
    const b = evaluation("b", [
      hourResult(T0, ["windTooStrong"]),
      hourResult(T0 + HOUR_MS, ["windTooStrong"]),
    ]);
    // gusts 2, windTooStrong 3.
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

  it("noGoOutranksAMoreFrequentMarginalKind", () => {
    const hours = [
      hourResult(T0, ["overdevelopment"], "marginal"),
      hourResult(T0 + HOUR_MS, ["overdevelopment"], "marginal"),
      hourResult(T0 + 2 * HOUR_MS, ["windTooWeak"]),
    ];
    expect(mainReason([evaluation("a", hours)]).kind).toBe("windTooWeak");
  });

  it("fallsBackToTheMostFrequentMarginalKind", () => {
    const hours = [
      hourResult(T0, ["preThermal", "gustUnavailable"], "marginal"),
      hourResult(T0 + HOUR_MS, ["preThermal", "overdevelopment"], "marginal"),
      hourResult(T0 + 2 * HOUR_MS, ["overdevelopment", "gustUnavailable"], "marginal"),
    ];
    // overdevelopment 2, preThermal 2: overdevelopment is declared first. Info kinds are ignored.
    expect(mainReason([evaluation("a", hours)])).toEqual({
      kind: "overdevelopment",
      severity: "marginal",
      text: "text overdevelopment",
    });
  });

  it("saysNoFlyableHourWhenThereIsNothingToCount", () => {
    const quiet = evaluation("a", [hourResult(T0, ["gustUnavailable"], "marginal")]);
    expect(mainReason([quiet])).toEqual({
      kind: "noFlyableHour",
      severity: "info",
      text: "no flyable hour",
    });
    expect(mainReason([]).kind).toBe("noFlyableHour");
  });

  it("noDataCountsAsANoGoKind", () => {
    expect(mainReason([evaluation("a", [hourResult(T0, ["noData"], "noData")])]).kind).toBe("noData");
  });
});

describe("recommendSite", () => {
  it("anOpenSiteWithAWindowHasBestAndNoMainReason", () => {
    const s = site("s");
    const r = recommendSite(s, [evaluation("x", [], 60)], undefined);
    expect(r.best?.window.score).toBe(60);
    expect(r.mainReason).toBeUndefined();
    expect(r.distanceM).toBeUndefined();
  });

  it("anOpenSiteWithoutAWindowHasAMainReason", () => {
    const r = recommendSite(site("s"), [evaluation("x", [hourResult(T0, ["gusts"])])], undefined);
    expect(r.best).toBeUndefined();
    expect(r.mainReason?.kind).toBe("gusts");
  });

  it("aClosedSiteHasNoLaunchesBestOrReason", () => {
    const where = { latitude: 39.5, longitude: -106 };
    const r = recommendSite(site("s", { closed: true }), [evaluation("x", [], 99)], where);
    expect(r.launches).toEqual([]);
    expect(r.best).toBeUndefined();
    expect(r.mainReason).toBeUndefined();
    expect(r.distanceM).toBe(0);
  });
});
