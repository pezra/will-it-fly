import { describe, expect, it } from "vitest";
import { testLaunch } from "../support/builders";
import type { Reason } from "../../src/core/scoring/hourEvaluator";
import {
  CONDITION_LABEL,
  approxFeet,
  arcLabel,
  callDisplay,
  callGlyph,
  callLabel,
  cautionLine,
  confidenceLabel,
  dayLabel,
  driveLabel,
  feet,
  forecastAge,
  hiddenLine,
  idealLabel,
  loadingMoreLine,
  miles,
  oneDecimal,
  stageMessage,
  travelSummary,
  whole,
} from "../../src/ui/format";

describe("number formats", () => {
  it("rounds cloud base to 100 ft with a leading ≈", () => {
    expect(approxFeet(1000)).toBe("≈ 3,300 ft");
    expect(approxFeet(0)).toBe("≈ 0 ft");
    expect(approxFeet(undefined)).toBe("n/a");
  });
  it("formats feet, miles, cape and TI", () => {
    expect(feet(9200)).toBe("9,200 ft");
    expect(miles(16093.44)).toBe("10 mi");
    expect(miles(8046.72)).toBe("5.0 mi");
    expect(miles(undefined)).toBeUndefined();
    expect(whole(1400.4)).toBe("1,400");
    expect(whole(undefined)).toBe("n/a");
    expect(oneDecimal(-2.14)).toBe("−2.1");
    expect(oneDecimal(3)).toBe("3.0");
    expect(oneDecimal(undefined)).toBe("n/a");
  });
});

describe("forecastAge", () => {
  const now = 10 * 3_600_000;
  it("uses minutes, hours and days", () => {
    expect(forecastAge(now, now)).toBe("Forecast from just now");
    expect(forecastAge(now - 12 * 60_000, now)).toBe("Forecast from 12 min ago");
    expect(forecastAge(now - 3 * 3_600_000, now)).toBe("Forecast from 3 h ago");
    expect(forecastAge(now - 72 * 3_600_000, now)).toBe("Forecast from 3 days ago");
  });
  it("treats a future fetch time as just now", () => {
    expect(forecastAge(now + 60_000, now)).toBe("Forecast from just now");
  });
});

describe("labels", () => {
  it("labels arcs with compass names", () => {
    expect(arcLabel({ from: 270, to: 310 })).toBe("270–310° (W–NW)");
    expect(arcLabel({ from: 330, to: 30 })).toBe("330–30° (NNW–NNE)");
  });
  it("gives every call a label and a glyph", () => {
    for (const call of ["good", "flyable", "noGo", "noData"] as const) {
      expect(callLabel(call).length).toBeGreaterThan(0);
      expect(callGlyph(call).length).toBeGreaterThan(0);
    }
    expect(callLabel("noGo")).toBe("No-go");
  });
  it("labels confidence", () => {
    expect(confidenceLabel("ecmwfOnly")).toBe("ECMWF only");
    expect(confidenceLabel("high")).toBe("high confidence");
  });
  it("labels days relative to today", () => {
    expect(dayLabel("2026-11-08", "2026-11-08")).toBe("Today");
    expect(dayLabel("2026-11-09", "2026-11-08")).toBe("Tomorrow");
    expect(dayLabel("2026-11-10", "2026-11-08")).toBe("Tue, Nov 10");
    expect(dayLabel("2027-01-01", "2026-12-31")).toBe("Tomorrow");
  });
});

describe("idealLabel", () => {
  const withIdeal = (ideal: { from: number; to: number }[]) =>
    idealLabel(testLaunch({ directions: { ok: [{ from: 180, to: 270 }], ideal } }));

  it("says anywhere in the OK range when there are no ideal arcs", () => {
    expect(withIdeal([])).toBe("anywhere in the OK range");
  });
  it("shows a zero-width ideal as the heading plus or minus 15 degrees", () => {
    expect(withIdeal([{ from: 200, to: 200 }])).toBe("185–215° (S–SW)");
  });
  it("wraps a widened arc below 0", () => {
    expect(withIdeal([{ from: 5, to: 5 }])).toMatch(/^350–20°/);
  });
  it("shows a normal arc as is", () => {
    expect(withIdeal([{ from: 250, to: 290 }])).toMatch(/^250–290°/);
  });
});

describe("driveLabel", () => {
  const route = (seconds: number) => ({ seconds, source: "route" as const });
  it("shows minutes under an hour and hours with leftover minutes", () => {
    expect(driveLabel(route(2700))).toBe("45m");
    expect(driveLabel(route(4800))).toBe("1h 20m");
    expect(driveLabel(route(3600))).toBe("1h");
  });
  it("rounds up to whole minutes, so a site labelled 2h is never over a 2 h limit", () => {
    expect(driveLabel(route(7200))).toBe("2h");
    expect(driveLabel(route(7201))).toBe("2h 1m");
    expect(driveLabel(route(4741))).toBe("1h 20m");
    expect(driveLabel(route(1))).toBe("1m");
  });
  it("prefixes estimates with ≈", () => {
    expect(driveLabel({ seconds: 4800, source: "estimate" })).toBe("≈ 1h 20m");
  });
});

describe("travelSummary", () => {
  const boulder = { latitude: 40.01, longitude: -105.27 };
  const place = { kind: "place" as const, name: "Boulder", coordinate: boulder };
  const here = { kind: "geolocation" as const };
  it("names the place or your location", () => {
    expect(travelSummary({ start: place, maxHours: 2 }, boulder, "found")).toBe(
      "Within 2 h of Boulder",
    );
    expect(travelSummary({ start: here, maxHours: 3 }, boulder, "found")).toBe(
      "Within 3 h of your location",
    );
  });
  it("asks for a start when there is none", () => {
    expect(travelSummary({ start: here, maxHours: 2 }, undefined, "denied")).toBe(
      "Set a starting point",
    );
    expect(travelSummary({ start: here, maxHours: 4 }, undefined, "unavailable")).toBe(
      "Set a starting point",
    );
  });
  it("says it is finding the location while geolocation is pending", () => {
    expect(travelSummary({ start: here, maxHours: 2 }, undefined, "pending")).toBe(
      "Finding your location…",
    );
  });
});

describe("hiddenLine", () => {
  it("counts the hidden sites and follows the limit", () => {
    expect(hiddenLine(3, 2)).toBe("3 sites hidden (over 2 h away)");
    expect(hiddenLine(5, 4)).toBe("5 sites hidden (over 4 h away)");
  });
  it("uses the singular for one", () => {
    expect(hiddenLine(1, 4)).toBe("1 site hidden (over 4 h away)");
  });
  it("says all are over the limit when nothing is left to show", () => {
    expect(hiddenLine(21, 2, 21)).toBe("All 21 sites are over 2 h away");
    expect(hiddenLine(1, 1, 1)).toBe("The only site is over 1 h away");
  });
  it("keeps the count form when some are shown", () => {
    expect(hiddenLine(3, 2, 21)).toBe("3 sites hidden (over 2 h away)");
  });
});

describe("stageMessage", () => {
  it("names what the list is waiting for", () => {
    expect(stageMessage("locating")).toBe("Finding your location…");
    expect(stageMessage("routing")).toBe("Finding sites in range…");
    expect(stageMessage("needsStart")).toBe("Set a starting point");
  });
  it("has nothing to say once ready", () => {
    expect(stageMessage("ready")).toBeUndefined();
  });
});

describe("loadingMoreLine", () => {
  it("counts the sites still loading", () => {
    expect(loadingMoreLine(4)).toBe("Loading 4 more sites…");
  });
  it("uses the singular for one", () => {
    expect(loadingMoreLine(1)).toBe("Loading 1 more site…");
  });
});

describe("CONDITION_LABEL", () => {
  it("names the three conditions", () => {
    expect(CONDITION_LABEL).toEqual({ soar: "Soar", xc: "XC", sledder: "Sledder" });
  });
});

describe("callDisplay", () => {
  it("gives pills for a good or flyable hour with conditions", () => {
    expect(callDisplay("good", ["soar", "xc"])).toEqual({
      kind: "pills",
      conditions: ["soar", "xc"],
    });
    expect(callDisplay("flyable", ["sledder"])).toEqual({
      kind: "pills",
      conditions: ["sledder"],
    });
  });
  it("falls back to a Sledder pill when conditions are missing or empty", () => {
    expect(callDisplay("good", undefined)).toEqual({ kind: "pills", conditions: ["sledder"] });
    expect(callDisplay("flyable", [])).toEqual({ kind: "pills", conditions: ["sledder"] });
  });
  it("gives a badge for no-go, no-data and closed, ignoring conditions", () => {
    expect(callDisplay("noGo", ["soar"])).toEqual({ kind: "badge", call: "noGo" });
    expect(callDisplay("noData", undefined)).toEqual({ kind: "badge", call: "noData" });
    expect(callDisplay("closed", [])).toEqual({ kind: "badge", call: "closed" });
  });
});

describe("cautionLine", () => {
  const caution = (text: string): Reason => ({ kind: "lowCloud", severity: "caution", text });

  it("has no line without cautions", () => {
    expect(cautionLine([])).toBeUndefined();
  });
  it("lists one or two cautions without a count", () => {
    expect(cautionLine([caution("low cloud")])).toBe("⚠ low cloud");
    expect(cautionLine([caution("low cloud"), caution("wind aloft 28 mph")])).toBe(
      "⚠ low cloud, wind aloft 28 mph",
    );
  });
  it("shows at most two and counts the rest", () => {
    expect(
      cautionLine([caution("a"), caution("b"), caution("c")]),
    ).toBe("⚠ a, b +1 more");
    expect(
      cautionLine([caution("a"), caution("b"), caution("c"), caution("d"), caution("e")]),
    ).toBe("⚠ a, b +3 more");
  });
  it("honours a custom cap", () => {
    expect(cautionLine([caution("a"), caution("b"), caution("c")], 1)).toBe("⚠ a +2 more");
  });
  it("keeps commas inside a caution's text", () => {
    expect(cautionLine([caution("wind 28 mph, gusty"), caution("low cloud")])).toBe(
      "⚠ wind 28 mph, gusty, low cloud",
    );
  });
});
