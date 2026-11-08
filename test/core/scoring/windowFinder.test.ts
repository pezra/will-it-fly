import { describe, expect, it } from "vitest";
import { SCORING_DEFAULTS } from "../../../src/core/scoring/defaults";
import type { HourCall, HourResult, Reason } from "../../../src/core/scoring/hourEvaluator";
import {
  daylightDayFor,
  daylightHours,
  findBestWindow,
  targetDay,
  windowLabel,
} from "../../../src/core/scoring/windowFinder";
import type { Confidence } from "../../../src/core/scoring/windowFinder";
import { HOUR_MS, byTime, formatDenverTime } from "../../../src/core/time";

// 2026-06-15, MDT (UTC-6). Denver hour h is (h + 6):00Z.
const at = (h: number): number => Date.UTC(2026, 5, 15, h + 6);
const DAY = { sunrise: at(6) + 40 * 60_000, sunset: at(20) + 10 * 60_000 };

function hr(h: number, call: HourCall, score = 80, wind = { speedMph: 10, dirDeg: 270 }): HourResult {
  return {
    time: at(h),
    call,
    score,
    reasons: [],
    launchWind: call === "noData" ? undefined : wind,
    unpenalizedScore: score,
  };
}

/** RRFS result at hour h that agrees with `hr(h, ...)` defaults, or disagrees by direction. */
function rrfsHr(h: number, agrees: boolean, call: HourCall = "good"): HourResult {
  return hr(h, call, 80, { speedMph: 10, dirDeg: agrees ? 270 : 90 });
}

const NOW_EARLY = at(0);

describe("targetDay", () => {
  it("is today before sunset and at sunset, tomorrow after", () => {
    expect(targetDay(DAY.sunset - 1, DAY.sunset)).toBe("today");
    expect(targetDay(DAY.sunset, DAY.sunset)).toBe("today");
    expect(targetDay(DAY.sunset + 1, DAY.sunset)).toBe("tomorrow");
  });
});

describe("daylightDayFor", () => {
  const tomorrow = { sunrise: DAY.sunrise + 24 * HOUR_MS, sunset: DAY.sunset + 24 * HOUR_MS };
  const days = [DAY, tomorrow];

  it("picks today's entry by Denver day key", () => {
    expect(daylightDayFor(days, "today", at(12))).toBe(DAY);
  });

  it("picks the next day for tomorrow", () => {
    expect(daylightDayFor(days, "tomorrow", at(22))).toBe(tomorrow);
  });

  it("is undefined when the day isn't in the response", () => {
    expect(daylightDayFor([DAY], "tomorrow", at(22))).toBeUndefined();
    expect(daylightDayFor([tomorrow], "today", at(12))).toBeUndefined();
    expect(daylightDayFor([], "today", at(12))).toBeUndefined();
  });

  it("uses the Denver calendar, not UTC: 22:00 MDT is already the next UTC day", () => {
    expect(daylightDayFor(days, "today", at(22))).toBe(DAY);
    expect(daylightDayFor(days, "tomorrow", at(22))).toBe(tomorrow);
  });
});

describe("daylightHours", () => {
  const all = Array.from({ length: 24 }, (_, h) => hr(h, "good"));
  const hoursOf = (rs: HourResult[]): number[] => rs.map((r) => (r.time - at(0)) / HOUR_MS);

  it("before sunrise, all of today's daylight counts: start >= sunrise and < sunset", () => {
    // Sunrise 06:40, so the 06:00 hour starts before sunrise and is out. Sunset 20:10 keeps 20:00.
    expect(hoursOf(daylightHours(all, DAY, NOW_EARLY))).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it("an hour starting exactly at sunrise counts; one starting exactly at sunset doesn't", () => {
    const exact = { sunrise: at(7), sunset: at(9) };
    expect(hoursOf(daylightHours(all, exact, NOW_EARLY))).toEqual([7, 8]);
  });

  it("at 11:30 the hour containing now counts and hour 10 doesn't", () => {
    const got = hoursOf(daylightHours(all, DAY, at(11) + 30 * 60_000));
    expect(got[0]).toBe(11);
    expect(got).not.toContain(10);
  });

  it("at exactly 11:00 hour 11 is the first", () => {
    expect(hoursOf(daylightHours(all, DAY, at(11)))[0]).toBe(11);
  });

  it("now between sunrise and the first whole hour doesn't revive the pre-sunrise hour", () => {
    expect(hoursOf(daylightHours(all, DAY, at(6) + 50 * 60_000))[0]).toBe(7);
  });

  it("after sunset the target is tomorrow, using tomorrow's daylight hours", () => {
    const tomorrow = { sunrise: DAY.sunrise + 24 * HOUR_MS, sunset: DAY.sunset + 24 * HOUR_MS };
    const now = DAY.sunset + 30 * 60_000;
    const which = targetDay(now, DAY.sunset);
    expect(which).toBe("tomorrow");
    const day = daylightDayFor([DAY, tomorrow], which, now);
    expect(day).toBe(tomorrow);
    const twoDays = Array.from({ length: 48 }, (_, h) => hr(h, "good"));
    const got = daylightHours(twoDays, tomorrow, now).map((r) => (r.time - at(0)) / HOUR_MS);
    expect(got[0]).toBe(31);
    expect(got[got.length - 1]).toBe(44);
  });

  it("returns the results in time order", () => {
    const shuffled = [hr(9, "good"), hr(8, "good"), hr(10, "good")];
    expect(hoursOf(daylightHours(shuffled, DAY, NOW_EARLY))).toEqual([8, 9, 10]);
  });
});

describe("findBestWindow", () => {
  const find = (
    ecmwf: HourResult[],
    rrfs: HourResult[] = [],
    now = NOW_EARLY,
  ) => findBestWindow(daylightHours(ecmwf, DAY, now), byTime(rrfs));

  it("is undefined with no hours", () => {
    expect(find([])).toBeUndefined();
  });

  it("an all-flyable run is a window", () => {
    const w = find([hr(10, "flyable"), hr(11, "flyable"), hr(12, "flyable")]);
    expect(w?.start).toBe(at(10));
    expect(w?.end).toBe(at(13));
  });

  it("a higher-scoring good run beats a lower-scoring flyable run", () => {
    const w = find([
      hr(9, "flyable", 45),
      hr(10, "flyable", 45),
      hr(11, "flyable", 45),
      hr(12, "noGo"),
      hr(13, "good", 80),
      hr(14, "good", 80),
      hr(15, "good", 80),
    ]);
    expect(w?.start).toBe(at(13));
  });

  it("an all-noGo day has no window", () => {
    expect(find([hr(10, "noGo"), hr(11, "noGo")])).toBeUndefined();
  });

  it("a run with one good hour among flyable hours is a window, flyable edges kept", () => {
    const w = find([hr(9, "flyable"), hr(10, "good"), hr(11, "flyable")]);
    expect(w?.start).toBe(at(9));
    expect(w?.end).toBe(at(12));
    expect(w?.hours.length).toBe(3);
  });

  it("start is the first hour's start, end is the last hour's start plus an hour", () => {
    const w = find([hr(11, "good"), hr(12, "good"), hr(13, "good")]);
    expect(w?.start).toBe(at(11));
    expect(w?.end).toBe(at(14));
  });

  it("a 1-hour run gets weight 0.6", () => {
    const w = find([hr(11, "good", 80)]);
    expect(w?.score).toBeCloseTo(80 * 0.6 * SCORING_DEFAULTS.ecmwfOnlyConfidenceWeight, 9);
  });

  it("a 2-hour run gets weight 0.8 and a 3-hour run 1.0", () => {
    const two = find([hr(11, "good", 80), hr(12, "good", 80)]);
    expect(two?.score).toBeCloseTo(80 * 0.8 * 0.85, 9);
    const three = find([hr(11, "good", 80), hr(12, "good", 80), hr(13, "good", 80)]);
    expect(three?.score).toBeCloseTo(80 * 1.0 * 0.85, 9);
  });

  it("the score is the mean hour score", () => {
    const w = find([hr(11, "good", 60), hr(12, "good", 80), hr(13, "good", 70)]);
    expect(w?.score).toBeCloseTo(70 * 0.85, 9);
  });

  it("with two runs, the higher-scoring run wins", () => {
    const w = find([
      hr(8, "good", 60),
      hr(9, "good", 60),
      hr(10, "good", 60),
      hr(11, "noGo"),
      hr(12, "good", 90),
      hr(13, "good", 90),
      hr(14, "good", 90),
    ]);
    expect(w?.start).toBe(at(12));
  });

  it("a short high-scoring run can lose to a longer run", () => {
    const w = find([
      hr(8, "good", 80),
      hr(9, "noGo"),
      hr(10, "good", 70),
      hr(11, "good", 70),
      hr(12, "good", 70),
    ]);
    expect(w?.start).toBe(at(10));
  });

  it("when two runs tie, the earlier one wins", () => {
    const w = find([
      hr(8, "good", 70),
      hr(9, "good", 70),
      hr(10, "good", 70),
      hr(11, "noGo"),
      hr(12, "good", 70),
      hr(13, "good", 70),
      hr(14, "good", 70),
    ]);
    expect(w?.start).toBe(at(8));
  });

  it("a noGo hour splits a run", () => {
    const w = find([hr(10, "good"), hr(11, "noGo"), hr(12, "good")]);
    expect(w?.hours.length).toBe(1);
  });

  it("a no-data hour splits a run", () => {
    const w = find([hr(10, "good"), hr(11, "good"), hr(12, "noData"), hr(13, "good")]);
    expect(w?.start).toBe(at(10));
    expect(w?.end).toBe(at(12));
  });

  it("a missing hour (gap in the array) splits a run", () => {
    const w = find([hr(10, "good", 80), hr(11, "good", 80), hr(13, "good", 80), hr(14, "good", 50)]);
    expect(w?.start).toBe(at(10));
    expect(w?.end).toBe(at(12));
  });

  it("only daylight hours are considered", () => {
    expect(find([hr(2, "good"), hr(3, "good"), hr(23, "good")])).toBeUndefined();
  });

  it("only hours from now onward are considered today", () => {
    const w = find([hr(9, "good"), hr(10, "good"), hr(11, "good"), hr(12, "good")], [], at(11) + 30 * 60_000);
    expect(w?.start).toBe(at(11));
  });

  describe("confidence", () => {
    const run = (n: number): HourResult[] => Array.from({ length: n }, (_, i) => hr(10 + i, "good", 80));
    const confidenceOf = (agreeing: boolean[], noRrfs: number[] = []): Confidence | undefined => {
      const ecmwf = run(agreeing.length);
      const rrfs = agreeing.flatMap((a, i) => (noRrfs.includes(i) ? [] : [rrfsHr(10 + i, a)]));
      return find(ecmwf, rrfs)?.confidence;
    };

    it("is ecmwfOnly with no RRFS at all, weight 0.85", () => {
      const w = find(run(4), []);
      expect(w?.confidence).toBe("ecmwfOnly");
      expect(w?.score).toBeCloseTo(80 * 0.85, 9);
    });

    it("75% agreement is high, 2 of 3 is medium", () => {
      expect(confidenceOf([true, true, true, false])).toBe("high");
      expect(confidenceOf([true, true, false])).toBe("medium");
    });

    it("40% agreement is medium, 2 of 6 is low", () => {
      expect(confidenceOf([true, true, false, false, false])).toBe("medium");
      expect(confidenceOf([true, true, false, false, false, false])).toBe("low");
    });

    it("weights are 1.0 high, 0.85 medium, 0.7 low", () => {
      const score = (agreeing: boolean[]): number | undefined =>
        find(run(agreeing.length), agreeing.map((a, i) => rrfsHr(10 + i, a)))?.score;
      expect(score([true, true, true, true])).toBeCloseTo(80, 9);
      expect(score([true, true, false])).toBeCloseTo(80 * 0.85, 9);
      expect(score([false, false, false, false])).toBeCloseTo(80 * 0.7, 9);
    });

    it("a run with half its RRFS hours missing is graded on the other half", () => {
      // 4 hours, RRFS covers 2 (50%, enough) and both agree -> high, not 2/4 = medium.
      expect(confidenceOf([true, true, true, true], [1, 3])).toBe("high");
    });

    it("RRFS under 50% present gives ecmwfOnly", () => {
      // 1 of 3 covered (33%).
      expect(confidenceOf([true, true, true], [1, 2])).toBe("ecmwfOnly");
    });

    it("exactly 50% coverage is enough", () => {
      expect(confidenceOf([true, true], [1])).toBe("high");
    });

    it("an RRFS noData hour counts as not covered", () => {
      const ecmwf = run(4);
      const rrfs = [
        rrfsHr(10, true),
        rrfsHr(11, true),
        hr(12, "noData"),
        hr(13, "noData"),
      ];
      expect(find(ecmwf, rrfs)?.confidence).toBe("high");
      expect(find(ecmwf, rrfs.slice(0, 1))?.confidence).toBe("ecmwfOnly");
    });

    it("a covered RRFS noGo hour counts as a disagreement", () => {
      const ecmwf = run(4);
      const rrfs = [rrfsHr(10, true), rrfsHr(11, true), rrfsHr(12, true, "noGo"), rrfsHr(13, true, "noGo")];
      expect(find(ecmwf, rrfs)?.confidence).toBe("medium");
    });

    it("matches RRFS hours by time, not array index", () => {
      const ecmwf = run(3);
      // Shuffled order and an extra hour outside the run.
      const rrfs = [rrfsHr(12, true), rrfsHr(5, false), rrfsHr(10, true), rrfsHr(11, true)];
      expect(find(ecmwf, rrfs)?.confidence).toBe("high");
    });

    it("RRFS hours outside the run don't count toward coverage", () => {
      const ecmwf = [...run(2), hr(13, "noGo")];
      const rrfs = [rrfsHr(13, true)];
      expect(find(ecmwf, rrfs)?.confidence).toBe("ecmwfOnly");
    });
  });

  it("takes the daylight hours as given and doesn't reselect them", () => {
    // Hours 3 and 4 are before DAY's sunrise; daylightHours would drop them, findBestWindow doesn't.
    const w = findBestWindow([hr(3, "good"), hr(4, "good")], new Map());
    expect(w?.start).toBe(at(3));
    expect(w?.hours.length).toBe(2);
  });

  it("looks RRFS up by time in the given map", () => {
    const daylight = [hr(10, "good"), hr(11, "good")];
    const agreeing = byTime([rrfsHr(10, true), rrfsHr(11, true)]);
    expect(findBestWindow(daylight, agreeing)?.confidence).toBe("high");
    expect(findBestWindow(daylight, new Map())?.confidence).toBe("ecmwfOnly");
  });

  describe("warnings", () => {
    const gusts = (text: string): Reason => ({ kind: "highGusts", severity: "warning", text });
    const caution: Reason = { kind: "nearMaxWind", severity: "caution", text: "near max" };
    const withReasons = (h: number, call: HourCall, reasons: Reason[]): HourResult => ({
      ...hr(h, call),
      reasons,
    });

    it("are the run's warning reasons, one per kind, first occurrence kept", () => {
      const w = find([
        withReasons(10, "good", [gusts("first")]),
        withReasons(11, "flyable", [caution, gusts("second")]),
        hr(12, "good"),
      ]);
      expect(w?.warnings).toEqual([gusts("first")]);
    });

    it("are empty without warning reasons, and ignore hours outside the run", () => {
      const w = find([
        withReasons(8, "good", [gusts("outside")]),
        hr(9, "noGo"),
        hr(10, "good", 90),
        withReasons(11, "flyable", [caution]),
        hr(12, "good", 90),
      ]);
      expect(w?.start).toBe(at(10));
      expect(w?.warnings).toEqual([]);
    });
  });

  it("uses the supplied defaults", () => {
    const d = { ...SCORING_DEFAULTS, oneHourRunWeight: 0.5, ecmwfOnlyConfidenceWeight: 1 };
    const w = findBestWindow([hr(11, "good", 80)], new Map(), d);
    expect(w?.score).toBeCloseTo(40, 9);
  });
});

describe("DST fall-back (2026-11-01, 25-hour day)", () => {
  // Denver midnight is 06:00Z (MDT). At 02:00 MDT clocks go back to 01:00 MST, so local hours
  // run 0,1,1,2,...,23. Sunrise 06:20 MST (13:20Z), sunset 16:50 MST (23:50Z).
  const midnight = Date.UTC(2026, 10, 1, 6);
  const dayHours = Array.from({ length: 25 }, (_, i) => midnight + i * HOUR_MS);
  const day = { sunrise: Date.UTC(2026, 10, 1, 13, 20), sunset: Date.UTC(2026, 10, 1, 23, 50) };
  const results = dayHours.map((time): HourResult => ({
    time,
    call: "good",
    score: 80,
    reasons: [],
    launchWind: { speedMph: 10, dirDeg: 270 },
    unpenalizedScore: 80,
  }));

  it("labels a window from 18Z to 21Z as 11:00-14:00 local", () => {
    const sel = results.filter((r) => r.time >= Date.UTC(2026, 10, 1, 18) && r.time < Date.UTC(2026, 10, 1, 21));
    const w = findBestWindow(daylightHours(sel, day, Date.UTC(2026, 10, 1, 7)), new Map());
    expect(w).toBeDefined();
    expect(windowLabel(w!)).toBe("11:00–14:00");
  });

  it("labels the daylight hours after the change in MST", () => {
    const w = findBestWindow(daylightHours(results, day, midnight), new Map());
    // First daylight hour is 14Z (07:00 MST); last is 23Z (16:00 MST).
    expect(windowLabel(w!)).toBe("07:00–17:00");
    expect(w!.hours.length).toBe(10);
  });

  it("a window across the repeated hour: 06Z-09Z labels 00:00-03:00 and shows 01:00 twice", () => {
    // 06Z is 00:00 MDT, 07Z is 01:00 MDT, 08Z is 01:00 MST (the change), 09Z is 02:00 MST.
    const early = { sunrise: midnight, sunset: midnight + 4 * HOUR_MS };
    const w = findBestWindow(daylightHours(results, early, midnight), new Map());
    expect(w?.hours.map((h) => h.time)).toEqual(dayHours.slice(0, 4));
    expect(windowLabel(w!)).toBe("00:00–03:00");
    expect(formatDenverTime(w!.hours[1]!.time)).toBe("01:00");
    expect(formatDenverTime(w!.hours[2]!.time)).toBe("01:00");
  });

  it("daylight selection and day lookup use the Denver calendar", () => {
    const nextDay = { sunrise: day.sunrise + 24 * HOUR_MS, sunset: day.sunset + 24 * HOUR_MS };
    const now = Date.UTC(2026, 10, 1, 5, 30); // 23:30 MDT on Oct 31
    expect(daylightDayFor([nextDay, day], "tomorrow", now)).toBe(day);
    expect(daylightDayFor([day, nextDay], "today", now)).toBeUndefined();
    const sel = daylightHours(results, day, now);
    expect(sel.length).toBe(10);
  });

  it("after sunset on Oct 31 the target is Nov 1", () => {
    const oct31 = { sunrise: Date.UTC(2026, 9, 31, 13, 20), sunset: Date.UTC(2026, 9, 31, 23, 55) };
    const now = oct31.sunset + 3 * HOUR_MS;
    expect(targetDay(now, oct31.sunset)).toBe("tomorrow");
    expect(daylightDayFor([oct31, day], "tomorrow", now)).toBe(day);
  });
});
