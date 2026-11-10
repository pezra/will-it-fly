import { describe, expect, it } from "vitest";
import type { LaunchForecast, ModelHour, NeighborWind } from "../../../src/core/forecast/models";
import { evaluateForecast, evaluateLaunch } from "../../../src/core/recommendation/evaluateLaunch";
import { findBestWindow } from "../../../src/core/scoring/windowFinder";
import type { HourResult, ReasonKind } from "../../../src/core/scoring/hourEvaluator";
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
    const e = evaluateLaunch(site, launch, f, denverDayKey(t(0)), t(0), "ecmwf");
    const { ecmwf, rrfs } = evaluateForecast(site, launch, f);
    expect(e.model).toBe("ecmwf");
    expect(e.fellBack).toBe(false);
    expect(e.daylight.map((row) => row.time)).toEqual([t(0), t(1), t(2), t(3)]);
    expect(e.daylight.map((row) => row.primary.result)).toEqual(ecmwf.slice(0, 4));
    expect(e.daylight.map((row) => row.primary.hour)).toEqual(f.ecmwf.slice(0, 4));
    expect(e.daylight.map((row) => row.check?.result.time)).toEqual([t(0), undefined, t(2), t(3)]);
    expect(e.daylight.map((row) => row.check?.hour)).toEqual([f.rrfs[0], undefined, f.rrfs[1], f.rrfs[2]]);
    expect(e.window).toBeDefined();
    expect(e.window).toEqual(findBestWindow(ecmwf.slice(0, 4), byTime(rrfs)));
  });

  it("hasNoDaylightOrWindowWhenTheDayIsNotCovered", () => {
    const f = forecast({ ecmwf: [0, 1].map(hour), days: [] });
    for (const model of ["ecmwf", "rrfs"] as const) {
      const e = evaluateLaunch(site, launch, f, denverDayKey(t(0)), t(0), model);
      expect(e.model).toBe(model);
      expect(e.fellBack).toBe(false);
      expect(e.daylight).toEqual([]);
      expect(e.window).toBeUndefined();
    }
  });
});

describe("evaluateLaunch with RRFS primary", () => {
  /** Four daylight hours, 0 to 3. */
  const day = { sunrise: t(0) - 30 * 60_000, sunset: t(4) };
  /** Twelve daylight hours, 0 to 11. */
  const longDay = { sunrise: t(0) - 30 * 60_000, sunset: t(12) };
  const key = denverDayKey(t(0));
  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const windy = (k: number, windMph: number): ModelHour =>
    perfectHour(t(k))
      .with((h) => (h.windMph = windMph))
      .build();
  /** An hour that is present but has no precipitation, so it is no data. */
  const noDataHour = (k: number): ModelHour =>
    perfectHour(t(k))
      .with((h) => (h.precipMm = undefined))
      .build();

  it("usesRRFSForTheCallsAndTheWindowWithECMWFAsTheCheck", () => {
    // ECMWF is stronger, so its hours score differently, but within the agreement limit.
    const f = forecast({ ecmwf: range(0, 3).map((k) => windy(k, 14)), rrfs: range(0, 3).map(hour), days: [day] });
    const e = evaluateLaunch(site, launch, f, key, t(0), "rrfs");
    const { ecmwf, rrfs } = evaluateForecast(site, launch, f, "rrfs");
    expect(rrfs[0]?.score).not.toBe(ecmwf[0]?.score);
    expect(e.model).toBe("rrfs");
    expect(e.fellBack).toBe(false);
    expect(e.daylight.map((row) => row.primary.result)).toEqual(rrfs);
    expect(e.daylight.map((row) => row.primary.hour)).toEqual(f.rrfs);
    expect(e.daylight.map((row) => row.check?.result)).toEqual(ecmwf);
    expect(e.daylight.map((row) => row.check?.hour)).toEqual(f.ecmwf);
    expect(e.window?.hours).toEqual(rrfs);
    expect(e.window).toEqual(findBestWindow(rrfs, byTime(ecmwf)));
  });

  it("judgesConfidenceByECMWFAgreeingWithRRFS", () => {
    // ECMWF is 6 mph stronger at hours 0 and 1 (over the 5 mph limit): 2 of 4 agree, medium.
    // Checking RRFS against itself would give high.
    const rrfs = range(0, 3).map(hour);
    const disagreeing = forecast({ ecmwf: [windy(0, 16), windy(1, 16), hour(2), hour(3)], rrfs, days: [day] });
    const e = evaluateLaunch(site, launch, disagreeing, key, t(0), "rrfs");
    expect(e.window?.hours).toEqual(evaluateForecast(site, launch, disagreeing, "rrfs").rrfs);
    expect(e.window?.confidence).toBe("medium");

    const agreeing = forecast({ ecmwf: range(0, 3).map(hour), rrfs, days: [day] });
    expect(evaluateLaunch(site, launch, agreeing, key, t(0), "rrfs").window?.confidence).toBe("high");
  });

  /** RRFS covering hours 0 to `covered - 1` of the long day, the rest absent or no data. */
  function coveredBy(covered: number, uncovered: "absent" | "noData"): LaunchForecast {
    const rrfs = range(0, 11).flatMap((k) => {
      if (k < covered) return [k === 2 ? stormHour(k) : hour(k)];
      return uncovered === "absent" ? [] : [noDataHour(k)];
    });
    return forecast({ ecmwf: range(0, 11).map(hour), rrfs, days: [longDay] });
  }

  for (const uncovered of ["absent", "noData"] as const) {
    it(`staysOnRRFSAtThreeQuartersOfTheWindowHours (${uncovered})`, () => {
      const e = evaluateLaunch(site, launch, coveredBy(9, uncovered), key, t(0), "rrfs");
      expect(e.model).toBe("rrfs");
      expect(e.fellBack).toBe(false);
    });

    it(`fallsBackToECMWFUnderThreeQuartersOfTheWindowHours (${uncovered})`, () => {
      const f = coveredBy(8, uncovered);
      const e = evaluateLaunch(site, launch, f, key, t(0), "rrfs");
      expect(e.model).toBe("ecmwf");
      expect(e.fellBack).toBe(true);
      expect({ ...e, fellBack: false }).toEqual(evaluateLaunch(site, launch, f, key, t(0), "ecmwf"));
      // ECMWF is evaluated again as the primary model, so it sees RRFS's storm at hour 2.
      expect(kinds(e.daylight[2]?.primary.result as HourResult)).toContain("rrfsSeesStorms");
    });
  }

  it("fallsBackWithNoRRFS", () => {
    const f = forecast({ ecmwf: range(0, 11).map(hour), rrfs: [], days: [longDay] });
    const e = evaluateLaunch(site, launch, f, key, t(0), "rrfs");
    expect(e.model).toBe("ecmwf");
    expect(e.fellBack).toBe(true);
  });

  it("fallsBackWhenRRFSEndsInTheMorning", () => {
    // A November day: sunrise 06:45, sunset 16:52, so the window hours are 07:00 to 16:00 (10).
    // RRFS runs out after 11:00: 5 of 10, under three quarters. t(0) is noon.
    const november = { sunrise: t(-5) - 15 * 60_000, sunset: t(4) + 52 * 60_000 };
    const f = forecast({ ecmwf: range(-6, 5).map(hour), rrfs: range(-6, -1).map(hour), days: [november] });
    const e = evaluateLaunch(site, launch, f, key, t(-6), "rrfs");
    expect(e.daylight.map((row) => row.time)).toEqual(range(-5, 4).map(t));
    expect([formatDenverTime(t(-5)), formatDenverTime(t(-1)), formatDenverTime(t(4))]).toEqual([
      "07:00",
      "11:00",
      "16:00",
    ]);
    expect(e.model).toBe("ecmwf");
    expect(e.fellBack).toBe(true);
  });

  it("todayCountsOnlyTheHoursFromNow", () => {
    // RRFS has only hours 9 to 11, 3 of the day's 12 but all of the 3 left from now.
    const f = forecast({ ecmwf: range(0, 11).map(hour), rrfs: range(9, 11).map(hour), days: [longDay] });
    const e = evaluateLaunch(site, launch, f, key, t(9) + 30 * 60_000, "rrfs");
    expect(e.model).toBe("rrfs");
    expect(e.fellBack).toBe(false);
    expect(e.daylight.map((row) => row.time)).toEqual([t(9), t(10), t(11)]);

    // A morning that's over doesn't count for RRFS either: 0 of the 3 hours left.
    const morning = forecast({ ecmwf: range(0, 11).map(hour), rrfs: range(0, 2).map(hour), days: [longDay] });
    const m = evaluateLaunch(site, launch, morning, key, t(9) + 30 * 60_000, "rrfs");
    expect(m.model).toBe("ecmwf");
    expect(m.fellBack).toBe(true);
  });

  it("keepsRRFSWithNoWindowHoursLeft", () => {
    const f = forecast({ ecmwf: range(0, 11).map(hour), rrfs: [], days: [longDay] });
    const e = evaluateLaunch(site, launch, f, key, t(12) + 60_000, "rrfs");
    expect(e.model).toBe("rrfs");
    expect(e.fellBack).toBe(false);
    expect(e.daylight).toEqual([]);
    expect(e.window).toBeUndefined();
  });
});

describe("the other model sees storms", () => {
  // ECMWF rains at hour 1 and RRFS at hour 4.
  const f = forecast({
    ecmwf: [hour(0), stormHour(1), hour(2), hour(3), hour(4), hour(5)],
    rrfs: [hour(0), hour(1), hour(2), hour(3), stormHour(4), hour(5)],
  });
  const has = (results: HourResult[], kind: ReasonKind): boolean => results.some((r) => kinds(r).includes(kind));

  it("isOnlyOnRRFSWhenRRFSIsPrimary", () => {
    const { ecmwf, rrfs } = evaluateForecast(site, launch, f, "rrfs");
    expect(has(rrfs, "ecmwfSeesStorms")).toBe(true);
    expect(has(rrfs, "rrfsSeesStorms")).toBe(false);
    expect(has(ecmwf, "ecmwfSeesStorms")).toBe(false);
    expect(has(ecmwf, "rrfsSeesStorms")).toBe(false);
  });

  it("isOnlyOnECMWFWhenECMWFIsPrimary", () => {
    const { ecmwf, rrfs } = evaluateForecast(site, launch, f, "ecmwf");
    expect(has(ecmwf, "rrfsSeesStorms")).toBe(true);
    expect(has(ecmwf, "ecmwfSeesStorms")).toBe(false);
    expect(has(rrfs, "ecmwfSeesStorms")).toBe(false);
    expect(has(rrfs, "rrfsSeesStorms")).toBe(false);
  });
});
