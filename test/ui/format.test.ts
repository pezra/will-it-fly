import { describe, expect, it } from "vitest";
import { testLaunch, testSite } from "../support/builders";
import type { LaunchEvaluation, SiteRecommendation } from "../../src/core/recommendation/types";
import type { ModelName, Reason } from "../../src/core/scoring/hourEvaluator";
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
  fallbackLine,
  hiddenLine,
  hourlyColumns,
  idealLabel,
  launchFallbackNote,
  loadingMoreLine,
  miles,
  oneDecimal,
  siteModel,
  sourceLabel,
  stageMessage,
  travelSummary,
  whole,
} from "../../src/ui/format";

describe("sourceLabel", () => {
  it("names the source by its host, without www", () => {
    expect(sourceLabel("https://www.rmhpa.org/flying-sites/kenosha-pass")).toBe("rmhpa.org");
    expect(sourceLabel("https://pawneeparagliding.com/")).toBe("pawneeparagliding.com");
  });
});

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
    for (const call of ["noGo", "noData"] as const) {
      expect(callLabel(call).length).toBeGreaterThan(0);
      expect(callGlyph(call).length).toBeGreaterThan(0);
    }
    expect(callLabel("noGo")).toBe("No-go");
  });
  it("labels confidence", () => {
    expect(confidenceLabel("high", "ecmwf")).toBe("high confidence");
  });
  it("names the primary model in the only-one-model label", () => {
    expect(confidenceLabel("primaryOnly", "ecmwf")).toBe("ECMWF only");
    expect(confidenceLabel("primaryOnly", "rrfs")).toBe("RRFS only");
  });
  it("leaves the other confidence levels alone whatever the model", () => {
    for (const model of ["ecmwf", "rrfs"] as const) {
      expect(confidenceLabel("high", model)).toBe("high confidence");
      expect(confidenceLabel("medium", model)).toBe("medium confidence");
      expect(confidenceLabel("low", model)).toBe("low confidence");
    }
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
  it("names the place or your location, then the model", () => {
    expect(travelSummary({ start: place, maxHours: 2 }, boulder, "found", "ecmwf")).toBe(
      "Within 2 h of Boulder · ECMWF",
    );
    expect(travelSummary({ start: place, maxHours: 2 }, boulder, "found", "rrfs")).toBe(
      "Within 2 h of Boulder · RRFS",
    );
    expect(travelSummary({ start: here, maxHours: 3 }, boulder, "found", "rrfs")).toBe(
      "Within 3 h of your location · RRFS",
    );
  });
  it("asks for a start when there is none, without the model", () => {
    for (const model of ["ecmwf", "rrfs"] as const) {
      expect(travelSummary({ start: here, maxHours: 2 }, undefined, "denied", model)).toBe(
        "Set a starting point",
      );
      expect(travelSummary({ start: here, maxHours: 4 }, undefined, "unavailable", model)).toBe(
        "Set a starting point",
      );
    }
  });
  it("says it is finding the location while geolocation is pending", () => {
    for (const model of ["ecmwf", "rrfs"] as const) {
      expect(travelSummary({ start: here, maxHours: 2 }, undefined, "pending", model)).toBe(
        "Finding your location…",
      );
    }
  });
});

describe("fallbackLine", () => {
  const evaluation = (fellBack: boolean): LaunchEvaluation => ({
    launch: testLaunch(),
    model: fellBack ? "ecmwf" : "rrfs",
    fellBack,
    daylight: [],
    window: undefined,
  });
  /** A site with one evaluation per entry: `true` for a launch that fell back. Empty means closed. */
  const site = (...launches: boolean[]): SiteRecommendation => ({
    site: testSite(),
    call: launches.length === 0 ? "closed" : "noGo",
    launches: launches.map(evaluation),
  });

  it("is undefined for ECMWF, even if a launch says it fell back", () => {
    expect(fallbackLine("ecmwf", [site(true), site(true)])).toBeUndefined();
  });
  it("is undefined for RRFS when nothing fell back, or nothing is shown", () => {
    expect(fallbackLine("rrfs", [site(false), site(false, false)])).toBeUndefined();
    expect(fallbackLine("rrfs", [])).toBeUndefined();
  });
  it("says RRFS doesn't cover the day when every evaluated site fell back", () => {
    expect(fallbackLine("rrfs", [site(true), site(true, true), site(true)])).toBe(
      "RRFS doesn't cover this day, so it uses ECMWF.",
    );
  });
  it("counts the sites that fell back when only some did", () => {
    expect(fallbackLine("rrfs", [site(true), site(false), site(true)])).toBe(
      "2 sites use ECMWF (RRFS doesn't cover this day).",
    );
  });
  it("uses the singular for one site out of several", () => {
    expect(fallbackLine("rrfs", [site(true), site(false), site(false)])).toBe(
      "1 site uses ECMWF (RRFS doesn't cover this day).",
    );
  });
  it("gives the all-sites line for a single evaluated site that fell back", () => {
    expect(fallbackLine("rrfs", [site(true)])).toBe("RRFS doesn't cover this day, so it uses ECMWF.");
  });
  it("counts a site as fallen back when any of its launches did", () => {
    expect(fallbackLine("rrfs", [site(true, false), site(false)])).toBe(
      "1 site uses ECMWF (RRFS doesn't cover this day).",
    );
  });
  it("doesn't count a site with no launch evaluations", () => {
    expect(fallbackLine("rrfs", [site(), site(true), site(true)])).toBe(
      "RRFS doesn't cover this day, so it uses ECMWF.",
    );
    expect(fallbackLine("rrfs", [site(), site(false), site(true)])).toBe(
      "1 site uses ECMWF (RRFS doesn't cover this day).",
    );
    expect(fallbackLine("rrfs", [site(), site()])).toBeUndefined();
  });
});

describe("siteModel", () => {
  const evaluation = (model: ModelName, fellBack: boolean): LaunchEvaluation => ({
    launch: testLaunch(),
    model,
    fellBack,
    daylight: [],
    window: undefined,
  });
  const rec = (launches: LaunchEvaluation[], best?: ModelName): SiteRecommendation => ({
    site: testSite(),
    call: best === undefined ? "noGo" : "flyable",
    launches,
    best:
      best === undefined
        ? undefined
        : {
            launch: testLaunch(),
            model: best,
            window: { start: 0, end: 0, hours: [], score: 0, confidence: "high", warnings: [], conditions: [], cautions: [] },
          },
  });

  it("is the best launch's model", () => {
    expect(siteModel(rec([evaluation("ecmwf", true), evaluation("rrfs", false)], "ecmwf"), "rrfs")).toBe("ecmwf");
    expect(siteModel(rec([evaluation("ecmwf", true), evaluation("rrfs", false)], "rrfs"), "rrfs")).toBe("rrfs");
  });
  it("is ECMWF with no window when every launch fell back", () => {
    expect(siteModel(rec([evaluation("ecmwf", true), evaluation("ecmwf", true)]), "rrfs")).toBe("ecmwf");
  });
  it("is the requested model with no window and mixed launches, or none", () => {
    expect(siteModel(rec([evaluation("ecmwf", true), evaluation("rrfs", false)]), "rrfs")).toBe("rrfs");
    expect(siteModel(rec([]), "rrfs")).toBe("rrfs");
  });
});

describe("launchFallbackNote", () => {
  it("says the launch uses ECMWF", () => {
    expect(launchFallbackNote).toBe("RRFS doesn't cover this day here, so this launch uses ECMWF.");
  });
});

describe("hourlyColumns", () => {
  const headers = (model: ModelName): string[] => hourlyColumns(model).map((c) => c.header);
  const reads = (model: ModelName): string[] =>
    hourlyColumns(model).map((c) => `${c.side ?? "-"}:${c.value}`);

  it("puts the primary model first when it is ECMWF", () => {
    expect(headers("ecmwf")).toEqual([
      "Time",
      "ECMWF",
      "Wind / gust / dir",
      "RRFS",
      "RRFS wind / dir",
      "CAPE J/kg",
      "Cloud base",
      "TI °C",
    ]);
  });
  it("puts the primary model first when it is RRFS", () => {
    expect(headers("rrfs")).toEqual([
      "Time",
      "RRFS",
      "Wind / gust / dir",
      "ECMWF",
      "ECMWF wind / dir",
      "CAPE J/kg",
      "Cloud base",
      "TI °C",
    ]);
  });
  it("reads the primary side for the call, the wind, CAPE, cloud base and TI, and the check side for the check", () => {
    const expected = [
      "-:time",
      "primary:call",
      "primary:wind",
      "check:call",
      "check:wind",
      "primary:cape",
      "primary:cloudBase",
      "primary:thermalIndex",
    ];
    expect(reads("ecmwf")).toEqual(expected);
    expect(reads("rrfs")).toEqual(expected);
  });
  it("shows the gust only on the primary wind column", () => {
    const withGust = hourlyColumns("rrfs").filter((c) => c.value === "wind" && c.withGust);
    expect(withGust.map((c) => c.side)).toEqual(["primary"]);
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
