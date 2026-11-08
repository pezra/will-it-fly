import { describe, expect, it } from "vitest";
import type { LaunchForecast, ModelHour, NeighborWind } from "../../../src/core/forecast/models";
import { evaluateForecast, evaluateLaunch } from "../../../src/core/recommendation/evaluateLaunch";
import { findBestWindow } from "../../../src/core/scoring/windowFinder";
import type { HourResult } from "../../../src/core/scoring/hourEvaluator";
import type { Launch, Site } from "../../../src/core/sites/site";
import { byTime, denverDayKey, formatDenverTime } from "../../../src/core/time";
import { kinds, testLaunch, testSite } from "../../support/builders";
import { REFERENCE_TIME, perfectHour } from "../../support/hourBuilder";

const HOUR_MS = 3_600_000;

const launch: Launch = testLaunch({
  directions: { ok: [{ from: 225, to: 315 }], ideal: [{ from: 250, to: 290 }] },
});
const site: Site = testSite({ launches: [launch] });

const t = (k: number): number => REFERENCE_TIME + k * HOUR_MS;
const hour = (k: number): ModelHour => perfectHour(t(k)).build();
const stormHour = (k: number): ModelHour =>
  perfectHour(t(k))
    .with((h) => {
      h.precipMm = 2;
      h.capeJkg = 500;
    })
    .build();
const wind = (k: number, windMph: number, windDir: number): NeighborWind => ({
  time: t(k),
  windMph,
  windDir,
});
const calm = (ks: number[]): NeighborWind[] => ks.map((k) => wind(k, 10, 270));

function forecast(parts: Partial<LaunchForecast>): LaunchForecast {
  return {
    launchID: launch.id,
    ecmwf: [],
    rrfs: [],
    neighborCenter: { ecmwf: [], rrfs: [] },
    neighbors: [],
    days: [],
    ...parts,
  };
}

describe("evaluateForecast", () => {
  it("alignsRRFSByTimeNotIndexWhenAnHourIsMissing", () => {
    // RRFS has no hour 1, and storms at hour 2. By index, RRFS[1] (hour 2) would pair with ECMWF
    // hour 1, and ECMWF hour 0 would see hour 2's rain as its "next".
    const f = forecast({
      ecmwf: [0, 1, 2, 3].map(hour),
      rrfs: [hour(0), stormHour(2), hour(3)],
    });
    const { ecmwf, rrfs } = evaluateForecast(site, launch, f);
    expect(ecmwf.map((r) => r.time)).toEqual([t(0), t(1), t(2), t(3)]);
    expect(rrfs.map((r) => r.time)).toEqual([t(0), t(2), t(3)]);
    expect(ecmwf.map((r) => kinds(r).includes("rrfsSeesStorms"))).toEqual([false, false, true, false]);
  });

  it("runsTheStormLookaheadByTimeAcrossAGap", () => {
    // RRFS has no hour 1. The storm at hour 2 is two hours after hour 0, so hour 0 is warned.
    const f = forecast({ rrfs: [hour(0), stormHour(2), hour(3)] });
    const { rrfs } = evaluateForecast(site, launch, f);
    expect(rrfs.map((r) => r.time)).toEqual([t(0), t(2), t(3)]);
    expect(rrfs.map((r) => r.call)).toEqual(["flyable", "noGo", "good"]);
    expect(rrfs[0]?.reasons.find((x) => x.kind === "stormsComing")?.text).toBe(
      `storms forecast by ${formatDenverTime(t(2))}`,
    );
  });

  it("aGapDoesNotMakeADistantStormLookAdjacent", () => {
    // The storm is three hours after hour 0 (look-ahead is two), though it is the next result.
    const f = forecast({ rrfs: [hour(0), stormHour(3)] });
    const { rrfs } = evaluateForecast(site, launch, f);
    expect(rrfs.map((r) => r.call)).toEqual(["good", "noGo"]);
  });

  it("appliesTheStormLookaheadWithinAStretch", () => {
    const f = forecast({ ecmwf: [hour(0), hour(1), stormHour(2)] });
    const { ecmwf } = evaluateForecast(site, launch, f);
    // Hour 1 is already a no-go (precipitation is the max of the hour and the next), hour 2 is the storm.
    expect(ecmwf.map((r) => r.call)).toEqual(["flyable", "noGo", "noGo"]);
    expect(kinds(ecmwf[0] as HourResult)).toContain("stormsComing");
  });

  it("pairsNeighborWindsByTimeInAnyOrder", () => {
    // The east neighbor disagrees violently at hour 2 only, and its series is in reverse order.
    const east = [3, 2, 1, 0].map((k) => (k === 2 ? wind(k, 15, 90) : wind(k, 10, 270)));
    const f = forecast({
      ecmwf: [0, 1, 2, 3].map(hour),
      neighborCenter: { ecmwf: calm([0, 1, 2, 3]), rrfs: [] },
      neighbors: [
        { bearingDeg: 0, ecmwf: calm([0, 1, 2, 3]), rrfs: [] },
        { bearingDeg: 90, ecmwf: east, rrfs: [] },
      ],
    });
    const { ecmwf } = evaluateForecast(site, launch, f);
    expect(ecmwf.map((r) => kinds(r).includes("neighborWindStrong"))).toEqual([false, false, true, false]);
  });

  it("sortsUnorderedInputAndEvaluatesEveryHour", () => {
    const f = forecast({ ecmwf: [hour(2), hour(0), hour(1)] });
    const { ecmwf, rrfs } = evaluateForecast(site, launch, f);
    expect(ecmwf.map((r) => r.time)).toEqual([t(0), t(1), t(2)]);
    expect(rrfs).toEqual([]);
  });
});

describe("evaluateLaunch", () => {
  const day = { sunrise: t(0) - 30 * 60_000, sunset: t(4) };

  it("joinsEachDaylightHourWithBothModelsByTime", () => {
    const f = forecast({ ecmwf: [0, 1, 2, 3, 4].map(hour), rrfs: [0, 2, 3, 4].map(hour), days: [day] });
    const e = evaluateLaunch(site, launch, f, denverDayKey(t(0)), t(0));
    const { ecmwf, rrfs } = evaluateForecast(site, launch, f);
    expect(e.daylight.map((row) => row.time)).toEqual([t(0), t(1), t(2), t(3)]);
    expect(e.daylight.map((row) => row.ecmwf)).toEqual(ecmwf.slice(0, 4));
    expect(e.daylight.map((row) => row.ecmwfHour)).toEqual(f.ecmwf.slice(0, 4));
    expect(e.daylight.map((row) => row.rrfs?.time)).toEqual([t(0), undefined, t(2), t(3)]);
    expect(e.daylight.map((row) => row.rrfsHour)).toEqual([f.rrfs[0], undefined, f.rrfs[1], f.rrfs[2]]);
    expect(e.window).toBeDefined();
    expect(e.window).toEqual(findBestWindow(ecmwf.slice(0, 4), byTime(rrfs)));
  });

  it("hasNoDaylightOrWindowWhenTheDayIsNotCovered", () => {
    const f = forecast({ ecmwf: [0, 1].map(hour), days: [] });
    const e = evaluateLaunch(site, launch, f, denverDayKey(t(0)), t(0));
    expect(e.daylight).toEqual([]);
    expect(e.window).toBeUndefined();
  });
});
