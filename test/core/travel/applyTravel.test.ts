import { describe, expect, it } from "vitest";
import type { RecommendationResult, SiteRecommendation } from "../../../src/core/recommendation/types";
import { distanceM } from "../../../src/core/sites/coordinate";
import type { Coordinate } from "../../../src/core/sites/site";
import { applyTravel } from "../../../src/core/travel/applyTravel";
import type { TravelTimes } from "../../../src/core/travel/applyTravel";
import { estimateDriveSeconds, startKey } from "../../../src/core/travel/driveTime";
import type { DriveTime } from "../../../src/core/travel/driveTime";
import { SECONDS_PER_HOUR } from "../../../src/core/units";
import { testLaunch, testSite } from "../../support/builders";

const START: Coordinate = { latitude: 40.0149, longitude: -105.2749 };
const OTHER_START: Coordinate = { latitude: 39.0, longitude: -106.5 };
const NEAR: Coordinate = { latitude: 40.1, longitude: -105.3 };
const FAR: Coordinate = { latitude: 37.0, longitude: -107.5 };

function rec(
  name: string,
  coordinate: Coordinate | undefined,
  o: { closed?: boolean; score?: number } = {},
): SiteRecommendation {
  const launches =
    coordinate === undefined
      ? []
      : [testLaunch({ id: `test/${name}/main`, coordinate })];
  const site = testSite({
    id: `test/${name}`,
    name,
    launches,
    status: o.closed === true ? { state: "closed", reason: "closed" } : { state: "open" },
  });
  if (o.closed === true) return { site, call: "closed", launches: [] };
  const best =
    o.score === undefined || launches[0] === undefined
      ? undefined
      : {
          launch: launches[0],
          window: { start: 0, end: 1, hours: [], score: o.score, confidence: "high" as const, warnings: [] },
        };
  return { site, call: best === undefined ? "noGo" : "flyable", best, launches: [] };
}

function resultOf(...sites: SiteRecommendation[]): RecommendationResult {
  return { day: "2026-07-15", today: "2026-07-15", dayOver: false, fetchedAt: 0, isOffline: false, sites };
}

function times(start: Coordinate, entries: Record<string, number>): TravelTimes {
  const map = new Map<string, DriveTime>(
    Object.entries(entries).map(([id, seconds]) => [`test/${id}`, { seconds, source: "route" }]),
  );
  return { startKey: startKey(start), times: map };
}

const names = (recs: readonly SiteRecommendation[]): string[] => recs.map((r) => r.site.name);
const byName = (recs: readonly SiteRecommendation[], name: string): SiteRecommendation => {
  const found = recs.find((r) => r.site.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

describe("applyTravel", () => {
  it("leavesTheResultUntouchedWithoutAStart", () => {
    const input = resultOf(rec("a", NEAR), rec("b", FAR));
    const out = applyTravel(input, undefined, undefined, 1);
    expect(out.result).toBe(input);
    expect(out.shown).toEqual(input.sites);
    expect(out.shown).not.toBe(input.sites);
    expect(out.hiddenCount).toBe(0);
  });

  it("takesDistancesAndTieBreaksFromTheGivenStart", () => {
    const west: Coordinate = { latitude: 40, longitude: -110 };
    const east: Coordinate = { latitude: 40, longitude: -100 };
    const input = resultOf(rec("west", west, { score: 50 }), rec("east", east, { score: 50 }));
    const nearWest = applyTravel(input, { latitude: 40, longitude: -109 }, undefined, undefined);
    const nearEast = applyTravel(input, { latitude: 40, longitude: -101 }, undefined, undefined);
    expect(names(nearWest.result.sites)).toEqual(["west", "east"]);
    expect(names(nearEast.result.sites)).toEqual(["east", "west"]);
    expect(byName(nearWest.result.sites, "west").distanceM).toBe(
      distanceM({ latitude: 40, longitude: -109 }, west),
    );
  });

  it("ignoresTimesForADifferentStart", () => {
    const input = resultOf(rec("far", FAR));
    const stale = times(OTHER_START, { far: 1 });
    const estimate = estimateDriveSeconds(START, FAR);
    expect(estimate).toBeGreaterThan(SECONDS_PER_HOUR);
    const out = applyTravel(input, START, stale, SECONDS_PER_HOUR);
    expect(byName(out.result.sites, "far").driveTime).toEqual({ seconds: estimate, source: "estimate" });
    expect(out.shown).toEqual([]);
    expect(out.hiddenCount).toBe(1);
  });

  it("estimatesFromTheUnroundedStart", () => {
    const out = applyTravel(resultOf(rec("near", NEAR)), START, undefined, undefined);
    expect(byName(out.result.sites, "near").driveTime?.seconds).toBe(estimateDriveSeconds(START, NEAR));
  });

  it("showsAtTheLimitAndHidesOneSecondOver", () => {
    const input = resultOf(rec("at", NEAR), rec("over", NEAR));
    const t = times(START, { at: SECONDS_PER_HOUR, over: SECONDS_PER_HOUR + 1 });
    const out = applyTravel(input, START, t, SECONDS_PER_HOUR);
    expect(names(out.shown)).toEqual(["at"]);
    expect(out.hiddenCount).toBe(1);
  });

  it("showsEverythingWithoutALimit", () => {
    const input = resultOf(rec("a", NEAR), rec("b", FAR));
    const out = applyTravel(input, START, undefined, undefined);
    expect(out.shown).toHaveLength(2);
    expect(out.hiddenCount).toBe(0);
  });

  it("prefersRoutedTimesToEstimates", () => {
    const t = times(START, { near: 90 });
    const out = applyTravel(resultOf(rec("near", NEAR)), START, t, undefined);
    expect(byName(out.result.sites, "near").driveTime).toEqual({ seconds: 90, source: "route" });
  });

  it("fallsBackToTheEstimateForAMissingId", () => {
    const t = times(START, { other: 90 });
    const out = applyTravel(resultOf(rec("near", NEAR)), START, t, undefined);
    expect(byName(out.result.sites, "near").driveTime).toEqual({
      seconds: estimateDriveSeconds(START, NEAR),
      source: "estimate",
    });
  });

  it("filtersClosedSitesLikeOthers", () => {
    const input = resultOf(rec("closedFar", FAR, { closed: true }), rec("closedNear", NEAR, { closed: true }));
    const out = applyTravel(input, START, undefined, 2 * SECONDS_PER_HOUR);
    expect(names(out.shown)).toEqual(["closedNear"]);
    expect(out.hiddenCount).toBe(1);
  });

  it("alwaysShowsASiteWithoutALaunch", () => {
    const out = applyTravel(resultOf(rec("none", undefined)), START, undefined, 1);
    const only = byName(out.result.sites, "none");
    expect(out.shown).toHaveLength(1);
    expect(only.driveTime).toBeUndefined();
    expect(only.distanceM).toBeUndefined();
    expect(out.hiddenCount).toBe(0);
  });

  it("keepsAFilteredOutSiteInTheResult", () => {
    const input = resultOf(rec("near", NEAR), rec("far", FAR));
    const out = applyTravel(input, START, undefined, SECONDS_PER_HOUR);
    expect(names(out.shown)).toEqual(["near"]);
    expect(out.result.sites).toHaveLength(2);
    expect(byName(out.result.sites, "far").driveTime).toBeDefined();
    expect(out.hiddenCount).toBe(1);
  });

  it("doesNotMutateItsInputs", () => {
    const input = resultOf(rec("near", NEAR), rec("far", FAR));
    const before = structuredClone(input);
    const t = times(START, { near: 5 });
    const tBefore = structuredClone(t);
    applyTravel(input, START, t, SECONDS_PER_HOUR);
    expect(input).toEqual(before);
    expect(input.sites.every((r) => !("driveTime" in r))).toBe(true);
    expect(t).toEqual(tBefore);
  });
});
