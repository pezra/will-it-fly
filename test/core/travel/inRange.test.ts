import { describe, expect, it } from "vitest";
import type { RecommendationResult } from "../../../src/core/recommendation/types";
import type { Coordinate, Site } from "../../../src/core/sites/site";
import type { TravelTimes } from "../../../src/core/travel/applyTravel";
import { startKey, withinReach } from "../../../src/core/travel/driveTime";
import type { DriveTime } from "../../../src/core/travel/driveTime";
import {
  containsSites,
  missingSiteIds,
  inRangeIds,
  mergeTimes,
  missingDestinations,
  routeDestinations,
  travelStage,
  wantedSiteIds,
  weatherLoadKey,
} from "../../../src/core/travel/inRange";
import type { TravelStage } from "../../../src/core/travel/inRange";
import { SECONDS_PER_HOUR } from "../../../src/core/units";
import { testLaunch, testSite } from "../../support/builders";

const START: Coordinate = { latitude: 40.015, longitude: -105.27 };
const OTHER_START: Coordinate = { latitude: 39.19, longitude: -106.82 };
const HOUR = SECONDS_PER_HOUR;

function siteAt(id: string, coordinate: Coordinate): Site {
  return testSite({ id, launches: [testLaunch({ id: `${id}/main`, coordinate })] });
}

/** Straight-line miles north of START, roughly. */
function north(miles: number): Coordinate {
  return { latitude: START.latitude + miles / 69, longitude: START.longitude };
}

const near = siteAt("near", north(20));
const mid = siteAt("mid", north(120));
const far = siteAt("far", north(300));
const noLaunch = testSite({ id: "none", launches: [] });

function routed(entries: Record<string, number>): Map<string, DriveTime> {
  return new Map(Object.entries(entries).map(([id, h]) => [id, { seconds: h * HOUR, source: "route" }]));
}

function timesAt(start: Coordinate, entries: Record<string, number>): TravelTimes {
  return { startKey: startKey(start), times: routed(entries) };
}

const ids = (sites: readonly { id: string }[]): string[] => sites.map((s) => s.id);

describe("inRangeIds", () => {
  it("keepsCandidatesWithinTheLimitInCandidateOrder", () => {
    const t = routed({ near: 0.5, mid: 1.5, far: 3 });
    expect(inRangeIds([far, near, mid], t, 2 * HOUR)).toEqual(["near", "mid"]);
  });

  it("includesATimeExactlyAtTheLimitAndExcludesOneSecondOver", () => {
    const t = new Map<string, DriveTime>([
      ["near", { seconds: 2 * HOUR, source: "route" }],
      ["mid", { seconds: 2 * HOUR + 1, source: "estimate" }],
    ]);
    expect(inRangeIds([near, mid], t, 2 * HOUR)).toEqual(["near"]);
  });

  it("leavesOutACandidateWithNoTime", () => {
    expect(inRangeIds([near, mid], routed({ near: 0.5 }), 4 * HOUR)).toEqual(["near"]);
  });

  it("alwaysIncludesASiteWithNoLaunch", () => {
    expect(inRangeIds([noLaunch], new Map(), HOUR)).toEqual(["none"]);
  });
});

describe("travelStage", () => {
  const stage = (o: Partial<Parameters<typeof travelStage>[0]>): TravelStage =>
    travelStage({ start: START, locationPending: false, candidates: [near], times: undefined, ...o });

  it("needsAStartWhenThereIsNoneAndNoLocationIsComing", () => {
    expect(stage({ start: undefined })).toBe("needsStart");
  });

  it("isLocatingWhileTheLocationIsPendingAndThereIsNoStart", () => {
    expect(stage({ start: undefined, locationPending: true })).toBe("locating");
  });

  it("aStartWinsOverAPendingLocation", () => {
    expect(stage({ locationPending: true, times: timesAt(START, { near: 1 }) })).toBe("ready");
  });

  it("isRoutingUntilTheCatalogIsRead", () => {
    expect(stage({ candidates: undefined, times: timesAt(START, { near: 1 }) })).toBe("routing");
  });

  it("isRoutingWithNoTimesOrTimesForAnotherStart", () => {
    expect(stage({ times: undefined })).toBe("routing");
    expect(stage({ times: timesAt(OTHER_START, { near: 1 }) })).toBe("routing");
  });

  it("isRoutingWhileACandidateHasNoTime", () => {
    expect(stage({ candidates: [near, mid], times: timesAt(START, { near: 1 }) })).toBe("routing");
  });

  it("isReadyWhenEveryCandidateHasATime", () => {
    expect(stage({ candidates: [near, mid], times: timesAt(START, { near: 1, mid: 2 }) })).toBe("ready");
  });

  it("aSiteWithNoLaunchNeedsNoTime", () => {
    expect(stage({ candidates: [noLaunch], times: timesAt(START, {}) })).toBe("ready");
  });

  it("noCandidatesIsReadyOnceTheStartHasItsMap", () => {
    expect(stage({ candidates: [], times: undefined })).toBe("routing");
    expect(stage({ candidates: [], times: timesAt(START, {}) })).toBe("ready");
  });

  it("narrowingStaysReadyWithASubsetOfTheIds", () => {
    const sites = [near, mid, far];
    const t = timesAt(START, { near: 0.5, mid: 2.5 });
    const wide = withinReach(sites, START, 3);
    const narrow = withinReach(sites, START, 2);
    expect(ids(wide)).toEqual(["near", "mid"]);
    expect(stage({ candidates: wide, times: t })).toBe("ready");
    expect(stage({ candidates: narrow, times: t })).toBe("ready");
    expect(inRangeIds(narrow, t.times, 2 * HOUR)).toEqual(["near"]);
    expect(inRangeIds(wide, t.times, 3 * HOUR)).toEqual(["near", "mid"]);
  });

  it("wideningToASupersetIsRoutingUntilTheNewIdsArrive", () => {
    const sites = [near, mid, far];
    let t = timesAt(START, { near: 0.5, mid: 2.5 });
    const wider = withinReach(sites, START, 3);
    const widest = withinReach(sites, START, 4);
    expect(ids(widest)).toEqual(["near", "mid", "far"]);
    expect(stage({ candidates: wider, times: t })).toBe("ready");
    expect(stage({ candidates: widest, times: t })).toBe("routing");
    t = mergeTimes(t, startKey(START), routed({ far: 3.5 }));
    expect(stage({ candidates: widest, times: t })).toBe("ready");
  });
});

describe("wantedSiteIds", () => {
  const stages: TravelStage[] = ["needsStart", "locating", "routing", "ready"];

  it("aSitePageWantsItsOwnSiteAtEveryStage", () => {
    for (const stage of stages) {
      expect(wantedSiteIds({ page: "site", routeSiteId: "far", stage, inRangeIds: ["near"] })).toEqual([
        "far",
      ]);
    }
  });

  it("theListWantsTheInRangeIdsOnlyWhenReady", () => {
    for (const stage of stages) {
      const wanted = wantedSiteIds({ page: "list", routeSiteId: undefined, stage, inRangeIds: ["near"] });
      expect(wanted).toEqual(stage === "ready" ? ["near"] : undefined);
    }
  });

  it("theListWithNoStartWantsNothing", () => {
    expect(
      wantedSiteIds({ page: "list", routeSiteId: undefined, stage: "needsStart", inRangeIds: [] }),
    ).toBeUndefined();
  });

  it("aReadyListWithNothingInRangeWantsNoSites", () => {
    expect(wantedSiteIds({ page: "list", routeSiteId: undefined, stage: "ready", inRangeIds: [] })).toEqual(
      [],
    );
  });
});

describe("weatherLoadKey", () => {
  it("isTheSameInAnyIdOrder", () => {
    expect(weatherLoadKey(undefined, ["b", "a", "c"])).toBe(weatherLoadKey(undefined, ["c", "b", "a"]));
  });

  it("differsByDayAndBySet", () => {
    expect(weatherLoadKey(undefined, ["a"])).not.toBe(weatherLoadKey("2026-11-09", ["a"]));
    expect(weatherLoadKey(undefined, ["a"])).not.toBe(weatherLoadKey(undefined, ["a", "b"]));
    expect(weatherLoadKey(undefined, ["a,b"])).not.toBe(weatherLoadKey(undefined, ["a", "b"]));
  });

  it("doesNotReorderItsInput", () => {
    const input = ["b", "a"];
    weatherLoadKey(undefined, input);
    expect(input).toEqual(["b", "a"]);
  });
});

describe("missingDestinations and mergeTimes", () => {
  const key = startKey(START);

  it("asksForEveryCandidateWithALaunchWhenNothingIsKnown", () => {
    expect(ids(missingDestinations([near, noLaunch, mid], undefined, key))).toEqual(["near", "mid"]);
    expect(routeDestinations([near])).toEqual([{ id: "near", coordinate: north(20) }]);
  });

  it("asksOnlyForCandidatesTheStartHasNoTimeFor", () => {
    const t = timesAt(START, { near: 1 });
    expect(ids(missingDestinations([near, mid], t, key))).toEqual(["mid"]);
    expect(missingDestinations([near], t, key)).toEqual([]);
  });

  it("asksForEverythingAgainForAnotherStart", () => {
    const t = timesAt(OTHER_START, { near: 1, mid: 1 });
    expect(ids(missingDestinations([near, mid], t, key))).toEqual(["near", "mid"]);
  });

  it("mergesIntoTheSameStartAndReplacesAnotherStart", () => {
    const merged = mergeTimes(timesAt(START, { near: 1 }), key, routed({ mid: 2 }));
    expect(merged.startKey).toBe(key);
    expect([...merged.times.keys()]).toEqual(["near", "mid"]);
    const replaced = mergeTimes(timesAt(OTHER_START, { near: 1 }), key, routed({ mid: 2 }));
    expect(replaced.startKey).toBe(key);
    expect([...replaced.times.keys()]).toEqual(["mid"]);
  });

  it("returnsTheSameObjectWhenNothingIsAdded", () => {
    const t = timesAt(START, { near: 1 });
    expect(mergeTimes(t, key, new Map())).toBe(t);
    expect(mergeTimes(undefined, key, new Map())).toEqual({ startKey: key, times: new Map() });
  });

  it("doesNotChangeItsInputs", () => {
    const t = timesAt(START, { near: 1 });
    const fetched = routed({ mid: 2 });
    mergeTimes(t, key, fetched);
    expect([...t.times.keys()]).toEqual(["near"]);
    expect([...fetched.keys()]).toEqual(["mid"]);
  });
});

describe("containsSites", () => {
  const result = (...sites: Site[]): RecommendationResult => ({
    model: "ecmwf",
    day: "2026-11-07",
    today: "2026-11-07",
    dayOver: false,
    fetchedAt: 0,
    isOffline: false,
    sites: sites.map((site) => ({ site, call: "noGo", launches: [] })),
  });

  it("isTrueForASubsetAndFalseWhenAnIdIsMissing", () => {
    expect(containsSites(result(near, mid), ["mid"])).toBe(true);
    expect(containsSites(result(near, mid), [])).toBe(true);
    expect(containsSites(result(near), ["near", "mid"])).toBe(false);
  });

  it("listsTheMissingIdsInTheOrderAsked", () => {
    expect(missingSiteIds(result(near), ["mid", "near", "far"])).toEqual(["mid", "far"]);
    expect(missingSiteIds(result(near, mid), ["mid"])).toEqual([]);
  });
});
