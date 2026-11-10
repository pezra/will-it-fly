import { describe, expect, it } from "vitest";
import type { ModelHour, NeighborWind } from "../../../src/core/forecast/models";
import { SCORING_DEFAULTS, lowCloudBaseCautionM } from "../../../src/core/scoring/defaults";
import type { ScoringDefaults } from "../../../src/core/scoring/defaults";
import { cloudBaseAboveLaunchM, launchWind, thermalIndex } from "../../../src/core/scoring/derived";
import {
  REASON_KIND_ORDER,
  REASON_SEVERITY,
  applyStormLookahead,
  effectiveIdealArcs,
  evaluateHour,
} from "../../../src/core/scoring/hourEvaluator";
import type {
  HourContext,
  HourResult,
  NeighborPointSample,
  NeighborSample,
  ReasonKind,
} from "../../../src/core/scoring/hourEvaluator";
import { daylightHours, findBestWindow, windowLabel } from "../../../src/core/scoring/windowFinder";
import type { FlyingWindow } from "../../../src/core/scoring/windowFinder";
import type { DegreeArc, Launch, Site, WindLimits } from "../../../src/core/sites/site";
import { DEFAULT_WIND_LIMITS, elevationM } from "../../../src/core/sites/site";
import { bundledSiteProvider } from "../../../src/core/sites/siteProvider";
import { formatDenverTime } from "../../../src/core/time";
import { METERS_PER_FOOT } from "../../../src/core/units";
import {
  PERFECT_LAUNCH_ELEVATION_M,
  REFERENCE_TIME,
  perfectHour,
} from "../../support/hourBuilder";
import type { HourBuilder } from "../../support/hourBuilder";
import { TEST_LIMITS, kinds, testLaunch, testSite } from "../../support/builders";

const HOUR_MS = 3_600_000;
const d = SCORING_DEFAULTS;
const sites: Site[] = await bundledSiteProvider().sites();

const OK: DegreeArc[] = [{ from: 225, to: 315 }];
const IDEAL: DegreeArc[] = [{ from: 250, to: 290 }];

interface LaunchOptions {
  elevationM?: number;
  ok?: DegreeArc[];
  ideal?: DegreeArc[];
  limits?: WindLimits;
}

function makeLaunch(o: LaunchOptions = {}): Launch {
  const launch = testLaunch({
    elevationFt: (o.elevationM ?? PERFECT_LAUNCH_ELEVATION_M) / METERS_PER_FOOT,
    directions: { ok: o.ok ?? OK, ideal: o.ideal ?? IDEAL },
  });
  if (o.limits !== undefined) launch.limits = o.limits;
  return launch;
}

function makeSite(launch: Launch, limits: WindLimits = TEST_LIMITS): Site {
  return testSite({ launches: [launch], limits });
}

function nw(windMph: number | undefined, windDir: number | undefined): NeighborWind {
  return { time: REFERENCE_TIME, windMph, windDir };
}

/** The center and all four neighbors at 10 mph from 270, for both models. */
function calmNeighbors(): { center: NeighborSample; points: NeighborPointSample[] } {
  return {
    center: { ecmwf: nw(10, 270), rrfs: nw(10, 270) },
    points: [0, 90, 180, 270].map((bearingDeg) => ({
      bearingDeg,
      ecmwf: nw(10, 270),
      rrfs: nw(10, 270),
    })),
  };
}

interface CtxOptions {
  model?: "ecmwf" | "rrfs";
  hour?: HourBuilder | ModelHour;
  next?: HourBuilder | ModelHour | undefined;
  /** The last hour: no next hour at all. */
  last?: boolean;
  other?: HourContext["other"];
  neighborCenter?: NeighborSample;
  neighbors?: NeighborPointSample[];
  launch?: Launch;
  siteLimits?: WindLimits;
}

function built(h: HourBuilder | ModelHour): ModelHour {
  return "build" in h ? h.build() : h;
}

function ctx(o: CtxOptions = {}): HourContext {
  const launch = o.launch ?? makeLaunch();
  const hour = built(o.hour ?? perfectHour());
  const nb = calmNeighbors();
  const c: HourContext = {
    model: o.model ?? "ecmwf",
    hour,
    next: o.last === true ? undefined : built(o.next ?? perfectHour(hour.time + HOUR_MS)),
    other: o.other,
    neighborCenter: o.neighborCenter ?? nb.center,
    neighbors: o.neighbors ?? nb.points,
    launch,
    site: makeSite(launch, o.siteLimits),
  };
  return c;
}

function evalWith(o: CtxOptions, defaults?: ScoringDefaults): HourResult {
  return evaluateHour(ctx(o), defaults);
}

function hourWith(change: (h: ModelHour) => void): HourBuilder {
  return perfectHour().with(change);
}

function nextWith(change: (h: ModelHour) => void): HourBuilder {
  return perfectHour(REFERENCE_TIME + HOUR_MS).with(change);
}

/** RRFS neighbors all calm except the one at `bearing`. */
function rrfsNeighborAt(bearing: number, wind: NeighborWind | undefined): NeighborPointSample[] {
  return calmNeighbors().points.map((p) => (p.bearingDeg === bearing ? { ...p, rrfs: wind } : p));
}

const PERFECT = evaluateHour(ctx());

describe("ReasonKind", () => {
  it("is declared no-go kinds first, then caution, then penalty, then bonus, then warning, then info", () => {
    const rank = { noGo: 0, caution: 1, penalty: 2, bonus: 3, warning: 4, info: 5 } as const;
    const ranks = REASON_KIND_ORDER.map((k) => rank[REASON_SEVERITY[k]]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("puts ECMWF sees storms right after RRFS sees storms", () => {
    expect(REASON_KIND_ORDER.indexOf("ecmwfSeesStorms")).toBe(REASON_KIND_ORDER.indexOf("rrfsSeesStorms") + 1);
    expect(REASON_SEVERITY.ecmwfSeesStorms).toBe("caution");
  });

  it("each reason carries its kind's severity and comes out in declaration order", () => {
    const r = evalWith({
      hour: hourWith((h) => {
        h.capeJkg = 600;
        h.lowCloudPct = 70;
        h.blhM = undefined;
      }),
    });
    for (const reason of r.reasons) expect(reason.severity).toBe(REASON_SEVERITY[reason.kind]);
    const idx = kinds(r).map((k) => REASON_KIND_ORDER.indexOf(k));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(new Set(kinds(r)).size).toBe(kinds(r).length);
  });
});

describe("baseline", () => {
  it("the perfect hour is good with no caution or no-go reasons and a high score", () => {
    expect(PERFECT.call).toBe("good");
    expect(PERFECT.reasons.filter((x) => x.severity !== "info")).toEqual([]);
    expect(PERFECT.score).toBeGreaterThanOrEqual(80);
    expect(PERFECT.time).toBe(REFERENCE_TIME);
    expect(PERFECT.launchWind).toEqual({ speedMph: 10, dirDeg: 270 });
  });

  it("carries the cloud base and thermal index it evaluated, no-data hours included", () => {
    const hour = perfectHour().build();
    const elev = elevationM(makeLaunch());
    expect(PERFECT.cloudBaseM).toBe(cloudBaseAboveLaunchM(hour));
    expect(PERFECT.thermalIndexC).toBe(thermalIndex(hour, elev));
    expect(PERFECT.cloudBaseM).toBeDefined();
    expect(PERFECT.thermalIndexC).toBeDefined();
    const noData = evalWith({ hour: hourWith((h) => (h.windMph = undefined)) });
    expect(noData.call).toBe("noData");
    expect(noData.cloudBaseM).toBe(PERFECT.cloudBaseM);
    expect(noData.thermalIndexC).toBe(PERFECT.thermalIndexC);
  });
});

describe("no-go rules", () => {
  const cases: [string, CtxOptions, ReasonKind][] = [
    ["precipitation", { hour: hourWith((h) => (h.precipMm = 1)) }, "precipitation"],
    ["too strong", { hour: hourWith((h) => (h.windMph = 20)) }, "windTooStrong"],
    ["too weak", { hour: hourWith((h) => (h.windMph = 4.5)) }, "windTooWeak"],
    ["wrong direction", { hour: hourWith((h) => (h.windDir = 90)) }, "wrongDirection"],
    [
      "over the back",
      { hour: perfectHour().level(700, (l) => ((l.windMph = 22), (l.windDir = 90))) },
      "overTheBack",
    ],
    ["strong aloft", { hour: perfectHour().level(700, (l) => (l.windMph = 40)) }, "strongAloft"],
    ["neighbor strong", { neighbors: rrfsNeighborAt(180, nw(12, 0)) }, "neighborWindStrong"],
  ];
  for (const [name, o, kind] of cases) {
    it(name, () => {
      const r = evalWith(o);
      expect(r.call).toBe("noGo");
      expect(kinds(r)).toContain(kind);
      expect(r.score).toBe(d.minScore);
    });
  }
});

describe("caution rules", () => {
  const cases: [string, CtxOptions, ReasonKind][] = [
    ["direction not ideal", { hour: hourWith((h) => (h.windDir = 240)) }, "directionNotIdeal"],
    ["near max", { hour: hourWith((h) => (h.windMph = 17)) }, "nearMaxWind"],
    ["not curated", { launch: makeLaunch({ ok: [], ideal: [] }) }, "notCurated"],
    ["overdevelopment", { hour: hourWith((h) => (h.capeJkg = 800)) }, "overdevelopment"],
    ["aloft", { hour: perfectHour().level(700, (l) => (l.windMph = 28)) }, "aloftWind"],
    ["low cloud base", { hour: hourWith((h) => (h.dewpointC = 19)) }, "lowCloud"],
    ["low cloud cover", { hour: hourWith((h) => (h.lowCloudPct = 80)) }, "lowCloud"],
    ["neighbor", { neighbors: rrfsNeighborAt(180, nw(8, 350)) }, "neighborWind"],
    [
      "RRFS sees storms",
      { other: { hour: hourWith((h) => (h.precipMm = 2)).build(), next: undefined } },
      "rrfsSeesStorms",
    ],
    [
      "ECMWF sees storms",
      { model: "rrfs", other: { hour: hourWith((h) => (h.precipMm = 2)).build(), next: undefined } },
      "ecmwfSeesStorms",
    ],
  ];
  for (const [name, o, kind] of cases) {
    it(name, () => {
      const r = evalWith(o);
      expect(r.call).toBe("flyable");
      expect(kinds(r)).toContain(kind);
      expect(r.score).toBeLessThan(PERFECT.score);
    });
  }
});

describe("penalty rules", () => {
  it("sledder costs a caution's points but keeps the hour good", () => {
    const r = evalWith({ hour: hourWith((h) => (h.blhM = 300)).level(600, (l) => (l.tempC = 0)) });
    expect(r.call).toBe("good");
    expect(r.reasons.find((x) => x.kind === "sledder")?.severity).toBe("penalty");
    expect(r.score).toBe(r.unpenalizedScore - d.cautionReasonPenalty);
  });
});

describe("ridge lift and XC bonuses", () => {
  const soaring = { notes: "test" };
  const withSite = (extra: Partial<Site>, o: CtxOptions = {}): HourResult => {
    const c = ctx(o);
    return evaluateHour({ ...c, site: { ...c.site, ...extra } });
  };

  it("adds nothing on a site that RMHPA does not call soarable or XC", () => {
    expect(kinds(PERFECT)).not.toContain("ridgeLift");
    expect(kinds(PERFECT)).not.toContain("xcPotential");
  });

  it("ridge lift: wind in an ideal arc at or above the minimum adds a bonus without changing the call", () => {
    const r = withSite({ soaring });
    expect(r.call).toBe("good");
    expect(r.reasons.find((x) => x.kind === "ridgeLift")?.severity).toBe("bonus");
    expect(r.unpenalizedScore).toBe(PERFECT.unpenalizedScore + d.ridgeLiftBonus);
  });

  it("ridge lift needs the minimum speed, a site can override it, and the ideal arc", () => {
    const slow = hourWith((h) => (h.windMph = d.ridgeLiftMinMph - 1));
    expect(kinds(withSite({ soaring }, { hour: slow }))).not.toContain("ridgeLift");
    expect(kinds(withSite({ soaring: { ...soaring, minMph: 6 } }, { hour: slow }))).toContain("ridgeLift");
    const okOnly = hourWith((h) => (h.windDir = 235));
    expect(kinds(withSite({ soaring }, { hour: okOnly }))).not.toContain("ridgeLift");
  });

  it("ridge lift only applies to the launches a site lists", () => {
    expect(kinds(withSite({ soaring: { ...soaring, launchIds: ["other/launch"] } }))).not.toContain("ridgeLift");
    const launch = makeLaunch();
    expect(kinds(withSite({ soaring: { ...soaring, launchIds: [launch.id] } }, { launch }))).toContain("ridgeLift");
  });

  it("ridge lift waives the sledder penalty", () => {
    const sledder = hourWith((h) => (h.blhM = 300)).level(600, (l) => (l.tempC = 0));
    expect(kinds(evalWith({ hour: sledder }))).toContain("sledder");
    const r = withSite({ soaring }, { hour: sledder });
    expect(kinds(r)).toContain("ridgeLift");
    expect(kinds(r)).not.toContain("sledder");
  });

  it("ridge lift never rescues a no-go hour", () => {
    const r = withSite({ soaring }, { hour: hourWith((h) => (h.precipMm = 1)) });
    expect(r.call).toBe("noGo");
    expect(r.score).toBe(d.minScore);
  });

  it("XC potential: strong thermals topping out high add a bonus on XC sites only", () => {
    const r = withSite({ xc: { notes: "test" } });
    expect(r.call).toBe("good");
    expect(r.reasons.find((x) => x.kind === "xcPotential")?.severity).toBe("bonus");
    expect(r.unpenalizedScore).toBe(PERFECT.unpenalizedScore + d.xcBonus);
  });

  it("XC potential needs a high BLH, a strong thermal index and calm enough air aloft", () => {
    const xc = { xc: { notes: "test" } };
    expect(kinds(withSite(xc, { hour: hourWith((h) => (h.blhM = d.xcBlhMinM - 1)) }))).not.toContain("xcPotential");
    expect(kinds(withSite(xc, { hour: hourWith((h) => (h.blhM = d.xcBlhMinM)) }))).toContain("xcPotential");
    const warm = perfectHour().level(600, (l) => (l.tempC = -2));
    expect(kinds(withSite(xc, { hour: warm }))).not.toContain("xcPotential");
    const windy = perfectHour().level(700, (l) => (l.windMph = d.aloftCautionMph));
    expect(kinds(withSite(xc, { hour: windy }))).not.toContain("xcPotential");
  });
});

describe("conditions", () => {
  const soaring = { notes: "test" };
  const xc = { notes: "test" };
  const withSite = (extra: Partial<Site>, o: CtxOptions = {}): HourResult => {
    const c = ctx(o);
    return evaluateHour({ ...c, site: { ...c.site, ...extra } });
  };
  const weakThermals = perfectHour().level(600, (l) => (l.tempC = -2));

  it("soar only: ridge lift with weak thermals", () => {
    expect(withSite({ soaring }, { hour: weakThermals }).conditions).toEqual(["soar"]);
  });

  it("xc only: strong thermals at a curated xc site", () => {
    expect(withSite({ xc }).conditions).toEqual(["xc"]);
  });

  it("soar and xc together, in that order", () => {
    expect(withSite({ soaring, xc }).conditions).toEqual(["soar", "xc"]);
  });

  it("sledder when neither applies", () => {
    expect(evalWith({ hour: weakThermals }).conditions).toEqual(["sledder"]);
  });

  it("xc shows at any site, but the bonus and the reason need a curated xc site", () => {
    // PERFECT is a strong-thermal hour at a site with no xc; 100 is its value before this change.
    const curated = withSite({ xc });
    expect(PERFECT.conditions).toContain("xc");
    expect(curated.conditions).toContain("xc");
    expect(kinds(PERFECT)).not.toContain("xcPotential");
    expect(kinds(curated)).toContain("xcPotential");
    expect(PERFECT.unpenalizedScore).toBe(100);
    expect(PERFECT.score).toBe(100);
    expect(curated.unpenalizedScore - PERFECT.unpenalizedScore).toBe(d.xcBonus);
  });

  it("xc needs the thermal index, boundary layer and aloft checks even without a curated xc site", () => {
    expect(evalWith({ hour: hourWith((h) => (h.blhM = d.xcBlhMinM - 1)) }).conditions).not.toContain("xc");
    expect(evalWith({ hour: hourWith((h) => (h.blhM = undefined)) }).conditions).not.toContain("xc");
    const windy = perfectHour().level(700, (l) => (l.windMph = d.aloftCautionMph));
    expect(evalWith({ hour: windy }).conditions).not.toContain("xc");
  });

  it("is empty for no-go and no-data hours", () => {
    expect(evalWith({ hour: hourWith((h) => (h.precipMm = 1)) }).conditions).toEqual([]);
    expect(evalWith({ hour: hourWith((h) => (h.windMph = undefined)) }).conditions).toEqual([]);
  });

  it("is kept on flyable hours", () => {
    const r = evalWith({ hour: hourWith((h) => (h.lowCloudPct = d.lowCloudCoverCautionPct)) });
    expect(r.call).toBe("flyable");
    expect(r.conditions).toEqual(["xc"]);
  });

  it("survives the storm look-ahead recomputing the call", () => {
    const c = ctx();
    const hours = [0, 1, 2, 3, 4].map((i) =>
      i === 4
        ? perfectHour(REFERENCE_TIME + i * HOUR_MS).with((h) => ((h.precipMm = 1), (h.capeJkg = 300))).build()
        : perfectHour(REFERENCE_TIME + i * HOUR_MS).build(),
    );
    const site = { ...c.site, soaring, xc };
    const results = hours.map((hour, i) =>
      evaluateHour({ ...c, site, hour, next: hours[i + 1] }),
    );
    const out = applyStormLookahead(results, hours);
    expect(results[1]?.call).toBe("good");
    expect(out[1]?.call).toBe("flyable");
    expect(out[1]?.conditions).toEqual(["soar", "xc"]);
    expect(out[1]?.conditions).toEqual(results[1]?.conditions);
    expect(out[3]?.call).toBe("noGo");
    expect(out[3]?.conditions).toEqual([]);
  });
});

describe("boundaries", () => {
  it("precipitation 0.24 / 0.25 mm in hour h", () => {
    expect(kinds(evalWith({ hour: hourWith((h) => (h.precipMm = 0.24)) }))).not.toContain("precipitation");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.precipMm = 0.25)) }))).toContain("precipitation");
  });

  it("precipitation in h+1 only", () => {
    expect(evalWith({ next: nextWith((h) => (h.precipMm = 0.24)) }).call).toBe("good");
    const r = evalWith({ next: nextWith((h) => (h.precipMm = 0.25)) });
    expect(r.call).toBe("noGo");
    expect(kinds(r)).toContain("precipitation");
  });

  it("max wind: exactly max is not no-go, just over is", () => {
    const at = evalWith({ hour: hourWith((h) => ((h.windMph = 18), (h.gustMph = 18))) });
    expect(at.call).toBe("flyable");
    expect(kinds(at)).toEqual(expect.arrayContaining(["nearMaxWind"]));
    expect(kinds(at)).not.toContain("windTooStrong");
    const over = evalWith({ hour: hourWith((h) => ((h.windMph = 18.1), (h.gustMph = 18.1))) });
    expect(over.call).toBe("noGo");
    expect(kinds(over)).toContain("windTooStrong");
    expect(kinds(over)).not.toContain("nearMaxWind");
  });

  it("launch limits override the site limits", () => {
    const launch = makeLaunch({ limits: { minMph: 0, idealMph: 10, maxMph: 25, gustFactorMph: 6 } });
    const r = evalWith({ launch, hour: hourWith((h) => (h.windMph = 20)) });
    expect(kinds(r)).not.toContain("windTooStrong");
    expect(r.call).toBe("good");
  });

  it("near max: max - 2 is flyable, just below is not", () => {
    expect(kinds(evalWith({ hour: hourWith((h) => (h.windMph = 15.9)) }))).not.toContain("nearMaxWind");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.windMph = 16)) }))).toContain("nearMaxWind");
  });

  it("min > 0: just below min is no-go, at min is not", () => {
    expect(kinds(evalWith({ hour: hourWith((h) => (h.windMph = 4.9)) }))).toContain("windTooWeak");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.windMph = 5)) }))).not.toContain("windTooWeak");
  });

  it("min of 0 never triggers the too-weak rule", () => {
    const limits: WindLimits = { minMph: 0, idealMph: 8, maxMph: 15, gustFactorMph: 20 };
    const r = evalWith({ siteLimits: limits, hour: hourWith((h) => (h.windMph = 0)) });
    expect(kinds(r)).not.toContain("windTooWeak");
    expect(r.call).not.toBe("noGo");
  });

  it("direction rule ignores direction below 4 mph", () => {
    const limits: WindLimits = { minMph: 0, idealMph: 8, maxMph: 15, gustFactorMph: 20 };
    const light = evalWith({
      siteLimits: limits,
      hour: hourWith((h) => ((h.windMph = 3.9), (h.windDir = 90))),
    });
    expect(kinds(light)).not.toContain("wrongDirection");
    expect(light.call).not.toBe("noGo");
    const at = evalWith({
      siteLimits: limits,
      hour: hourWith((h) => ((h.windMph = 4), (h.windDir = 90))),
    });
    expect(kinds(at)).toContain("wrongDirection");
  });

  it("below 4 mph there is no ideal bonus and no not-ideal caution", () => {
    const limits: WindLimits = { minMph: 0, idealMph: 3.9, maxMph: 15, gustFactorMph: 20 };
    const inIdeal = evalWith({ siteLimits: limits, hour: hourWith((h) => (h.windMph = 3.9)) });
    const notIdeal = evalWith({
      siteLimits: limits,
      hour: hourWith((h) => ((h.windMph = 3.9), (h.windDir = 240))),
    });
    expect(kinds(notIdeal)).not.toContain("directionNotIdeal");
    expect(inIdeal.score).toBe(notIdeal.score);
  });

  it("CAPE 499 / 500", () => {
    expect(kinds(evalWith({ hour: hourWith((h) => (h.capeJkg = 499)) }))).not.toContain("overdevelopment");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.capeJkg = 500)) }))).toContain("overdevelopment");
  });

  it("aloft 24 / 25 / 34 / 35 mph", () => {
    const at = (mph: number) =>
      evalWith({ hour: perfectHour().level(700, (l) => (l.windMph = mph)) });
    expect(at(24).call).toBe("good");
    expect(kinds(at(25))).toContain("aloftWind");
    expect(at(25).call).toBe("flyable");
    expect(at(34).call).toBe("flyable");
    expect(kinds(at(34))).not.toContain("strongAloft");
    expect(at(35).call).toBe("noGo");
    expect(kinds(at(35))).toContain("strongAloft");
    expect(kinds(at(35))).not.toContain("aloftWind");
  });

  it("over the back 19 / 20 mph", () => {
    const at = (mph: number) =>
      evalWith({ hour: perfectHour().level(700, (l) => ((l.windMph = mph), (l.windDir = 90))) });
    expect(at(19).call).toBe("good");
    expect(kinds(at(20))).toContain("overTheBack");
    expect(at(20).call).toBe("noGo");
  });

  it("aloft from inside ok at 20 mph is not over the back", () => {
    const r = evalWith({ hour: perfectHour().level(700, (l) => (l.windMph = 20)) });
    expect(kinds(r)).not.toContain("overTheBack");
  });

  it("cloud base 1499 / 1500 ft above launch", () => {
    const launch = makeLaunch();
    const spreadFor = (ft: number) => (ft * METERS_PER_FOOT) / d.cloudBaseMPerDegSpread;
    const below = hourWith((h) => ((h.tempC = spreadFor(1499)), (h.dewpointC = 0))).build();
    const at = hourWith((h) => ((h.tempC = spreadFor(1500)), (h.dewpointC = 0))).build();
    // Preconditions: the inputs really straddle the threshold.
    expect(cloudBaseAboveLaunchM(below)).toBeLessThan(lowCloudBaseCautionM());
    expect(cloudBaseAboveLaunchM(at)).toBeGreaterThanOrEqual(lowCloudBaseCautionM());
    expect(kinds(evalWith({ launch, hour: below }))).toContain("lowCloud");
    expect(kinds(evalWith({ launch, hour: at }))).not.toContain("lowCloud");
  });

  it("low cloud cover 59 / 60 %", () => {
    expect(kinds(evalWith({ hour: hourWith((h) => (h.lowCloudPct = 59)) }))).not.toContain("lowCloud");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.lowCloudPct = 60)) }))).toContain("lowCloud");
  });

  it("neighbor 60 / 61 degrees (neighbor < 10 mph)", () => {
    expect(evalWith({ neighbors: rrfsNeighborAt(180, nw(9.9, 330)) }).call).toBe("good");
    const r = evalWith({ neighbors: rrfsNeighborAt(180, nw(9.9, 331)) });
    expect(r.call).toBe("flyable");
    expect(kinds(r)).toContain("neighborWind");
  });

  it("neighbor 90 / 91 degrees (neighbor < 10 mph)", () => {
    const at90 = evalWith({ neighbors: rrfsNeighborAt(180, nw(9.9, 0)) });
    expect(at90.call).toBe("flyable");
    expect(kinds(at90)).toContain("neighborWind");
    const at91 = evalWith({ neighbors: rrfsNeighborAt(180, nw(9.9, 1)) });
    expect(at91.call).toBe("noGo");
    expect(kinds(at91)).toContain("neighborWindStrong");
    expect(kinds(at91)).not.toContain("neighborWind");
  });

  it("neighbor 9.9 / 10 mph at 61 degrees", () => {
    expect(kinds(evalWith({ neighbors: rrfsNeighborAt(180, nw(9.9, 331)) }))).toContain("neighborWind");
    const r = evalWith({ neighbors: rrfsNeighborAt(180, nw(10, 331)) });
    expect(r.call).toBe("noGo");
    expect(kinds(r)).toContain("neighborWindStrong");
  });

  it("neighbor 4.9 / 5 mph minimum, on both sides", () => {
    expect(evalWith({ neighbors: rrfsNeighborAt(180, nw(4.9, 90)) }).call).toBe("good");
    expect(evalWith({ neighbors: rrfsNeighborAt(180, nw(5, 90)) }).call).toBe("noGo");
    const weakCenter: NeighborSample = { ecmwf: nw(10, 270), rrfs: nw(4.9, 270) };
    expect(
      evalWith({ neighborCenter: weakCenter, neighbors: rrfsNeighborAt(180, nw(12, 90)) }).call,
    ).toBe("good");
    const minCenter: NeighborSample = { ecmwf: nw(10, 270), rrfs: nw(5, 270) };
    expect(
      evalWith({ neighborCenter: minCenter, neighbors: rrfsNeighborAt(180, nw(12, 90)) }).call,
    ).toBe("noGo");
  });

  it("BLH 499 / 500 m with TI 0 / 0.1", () => {
    const launch = makeLaunch();
    const elev = elevationM(launch);
    const hourFor = (blh: number, ti: number) =>
      perfectHour()
        .with((h) => (h.blhM = blh))
        .level(600, (l) => {
          // Same expression as the TI parcel, so TI is exactly `ti` at 0.
          const parcel = 20 - d.dryAdiabaticLapseCPerM * (4400 - elev);
          l.tempC = parcel + ti;
        })
        .build();
    expect(thermalIndex(hourFor(499, 0), elev)).toBe(0);
    expect(thermalIndex(hourFor(499, 0.1), elev)).toBeGreaterThan(0);
    expect(kinds(evalWith({ launch, hour: hourFor(499, 0.1) }))).toContain("sledder");
    expect(kinds(evalWith({ launch, hour: hourFor(500, 0.1) }))).not.toContain("sledder");
    expect(kinds(evalWith({ launch, hour: hourFor(499, 0) }))).not.toContain("sledder");
  });
});

describe("nil handling", () => {
  it("undefined launch wind speed or direction gives no data", () => {
    for (const change of [
      (h: ModelHour) => (h.windMph = undefined),
      (h: ModelHour) => (h.windDir = undefined),
    ]) {
      const r = evalWith({ hour: hourWith(change) });
      expect(r.call).toBe("noData");
      expect(kinds(r)).toEqual(["noData"]);
      expect(r.score).toBe(d.minScore);
    }
  });

  it("undefined precipitation in hour h gives no data", () => {
    const r = evalWith({ hour: hourWith((h) => (h.precipMm = undefined)) });
    expect(r.call).toBe("noData");
    expect(kinds(r)).toEqual(["noData"]);
  });

  it("undefined precipitation in h+1 only falls back to hour h", () => {
    expect(evalWith({ next: nextWith((h) => (h.precipMm = undefined)) }).call).toBe("good");
    const r = evalWith({
      hour: hourWith((h) => (h.precipMm = 1)),
      next: nextWith((h) => (h.precipMm = undefined)),
    });
    expect(kinds(r)).toContain("precipitation");
  });

  it("the last hour (no next) uses hour h alone", () => {
    expect(evalWith({ last: true }).call).toBe("good");
    expect(kinds(evalWith({ last: true, hour: hourWith((h) => (h.precipMm = 1)) }))).toContain(
      "precipitation",
    );
  });

  it("undefined gust in both hours gives no warning and no reason at all", () => {
    const r = evalWith({
      hour: hourWith((h) => (h.gustMph = undefined)),
      next: nextWith((h) => (h.gustMph = undefined)),
    });
    expect(r.call).toBe("good");
    expect(kinds(r)).toEqual(kinds(PERFECT));
    expect(r.reasons.filter((x) => /gust/i.test(x.text))).toEqual([]);
  });

  it("a gust present in only one of h and h+1 is still checked for the warning", () => {
    const r = evalWith({
      hour: hourWith((h) => (h.gustMph = undefined)),
      next: nextWith((h) => (h.gustMph = 40)),
    });
    expect(kinds(r)).toContain("highGusts");
  });

  describe("gust factor uses each hour's own 10 m wind", () => {
    const limits: WindLimits = { minMph: 0, idealMph: 10, maxMph: 40, gustFactorMph: 5 };
    const gustsWith = (h: ModelHour, wind: number | undefined, gust: number | undefined): void => {
      h.windMph = wind;
      h.gustMph = gust;
    };
    const run = (hour: (h: ModelHour) => void, next: (h: ModelHour) => void) =>
      kinds(evalWith({ launch: makeLaunch({ limits }), hour: hourWith(hour), next: nextWith(next) }));

    it("does not warn when the next hour's high gust sits on a high wind", () => {
      // Factors are 3 and 5, under 3 x 5. The old code took gust 25 minus hour h's wind 5 = 20.
      const k = run((h) => gustsWith(h, 5, 8), (h) => gustsWith(h, 20, 25));
      expect(k).not.toContain("highGusts");
    });

    it("warns when the next hour has a real gust factor of 15", () => {
      const k = run((h) => gustsWith(h, 5, 8), (h) => gustsWith(h, 10, 25));
      expect(k).toContain("highGusts");
    });

    it("skips a term whose wind is undefined, and does not warn with no terms", () => {
      expect(run((h) => gustsWith(h, 10, 40), (h) => gustsWith(h, undefined, 12))).toContain("highGusts");
      expect(run((h) => gustsWith(h, 10, undefined), (h) => gustsWith(h, 10, 40))).toContain("highGusts");
      expect(run((h) => gustsWith(h, 10, undefined), (h) => gustsWith(h, undefined, 40))).not.toContain(
        "highGusts",
      );
    });

    it("clamps a gust below the wind at 0", () => {
      const r = run((h) => gustsWith(h, 12, 8), (h) => gustsWith(h, 12, 8));
      expect(r).not.toContain("highGusts");
    });
  });

  it("sledder with only BLH", () => {
    const noTI = (b: HourBuilder) =>
      b.level(600, (l) => (l.tempC = undefined)).level(500, (l) => (l.tempC = undefined));
    const low = noTI(hourWith((h) => (h.blhM = 400))).build();
    expect(thermalIndex(low, PERFECT_LAUNCH_ELEVATION_M)).toBeUndefined();
    expect(kinds(evalWith({ hour: low }))).toEqual(
      expect.arrayContaining(["sledder", "thermalIndexUnavailable"]),
    );
    expect(kinds(evalWith({ hour: noTI(hourWith((h) => (h.blhM = 600))) }))).not.toContain("sledder");
  });

  it("sledder with only TI", () => {
    const warm = hourWith((h) => (h.blhM = undefined)).level(600, (l) => (l.tempC = 0));
    expect(kinds(evalWith({ hour: warm }))).toEqual(
      expect.arrayContaining(["sledder", "blhUnavailable"]),
    );
    expect(kinds(evalWith({ hour: hourWith((h) => (h.blhM = undefined)) }))).not.toContain("sledder");
  });

  it("sledder with neither BLH nor TI is skipped as n/a", () => {
    const r = evalWith({
      hour: hourWith((h) => (h.blhM = undefined))
        .level(600, (l) => (l.tempC = undefined))
        .level(500, (l) => (l.tempC = undefined)),
    });
    expect(kinds(r)).not.toContain("sledder");
    expect(kinds(r)).toEqual(expect.arrayContaining(["blhUnavailable", "thermalIndexUnavailable"]));
    expect(r.call).toBe("good");
  });

  it("missing CAPE, cloud inputs and aloft levels are skipped as n/a, not failed", () => {
    const r = evalWith({
      hour: hourWith((h) => {
        h.capeJkg = undefined;
        h.dewpointC = undefined;
        h.lowCloudPct = undefined;
      })
        .withoutLevel(700)
        .withoutLevel(600)
        .withoutLevel(500),
    });
    expect(r.call).toBe("good");
    expect(kinds(r)).toEqual(
      expect.arrayContaining([
        "capeUnavailable",
        "cloudBaseUnavailable",
        "lowCloudCoverUnavailable",
        "aloftWindUnavailable",
      ]),
    );
  });
});

describe("empty ok", () => {
  it("a 10 mph wind and a 25 mph tailwind aloft are flyable 'not curated', not no-go", () => {
    const r = evalWith({
      launch: makeLaunch({ ok: [], ideal: [] }),
      hour: hourWith((h) => (h.windDir = 90)).level(700, (l) => ((l.windMph = 25), (l.windDir = 90))),
    });
    expect(r.call).toBe("flyable");
    expect(kinds(r)).toContain("notCurated");
    expect(kinds(r)).not.toContain("wrongDirection");
    expect(kinds(r)).not.toContain("overTheBack");
  });

  it("strong aloft still applies with empty ok", () => {
    const r = evalWith({
      launch: makeLaunch({ ok: [], ideal: [] }),
      hour: perfectHour().level(700, (l) => (l.windMph = 35)),
    });
    expect(r.call).toBe("noGo");
    expect(kinds(r)).toContain("strongAloft");
  });

  it("earns no direction bonus", () => {
    const r = evalWith({ launch: makeLaunch({ ok: [], ideal: [] }) });
    expect(r.unpenalizedScore).toBe(PERFECT.unpenalizedScore - d.idealDirectionBonus);
  });
});

describe("gusts are not scored", () => {
  /** The perfect hour with gusts missing in both h and h+1. */
  function withoutGusts(o: CtxOptions = {}): HourResult {
    return evalWith({
      ...o,
      hour: hourWith((h) => (h.gustMph = undefined)),
      next: nextWith((h) => (h.gustMph = undefined)),
    });
  }

  it("a 40 mph gust (no warning) leaves the call, score and reasons as without gusts", () => {
    const limits: WindLimits = { ...TEST_LIMITS, gustFactorMph: 20 };
    const base = withoutGusts({ siteLimits: limits });
    const r = evalWith({
      siteLimits: limits,
      hour: hourWith((h) => (h.gustMph = 40)),
      next: nextWith((h) => (h.gustMph = 40)),
    });
    expect(r.call).toBe("good");
    expect(r.call).toBe(base.call);
    expect(r.score).toBe(base.score);
    expect(r.unpenalizedScore).toBe(base.unpenalizedScore);
    expect(r.reasons).toEqual(base.reasons);
  });

  it("a gust factor of 30 warns but leaves the call and score as without gusts", () => {
    const base = withoutGusts();
    const r = evalWith({
      hour: hourWith((h) => (h.gustMph = 40)),
      next: nextWith((h) => (h.gustMph = 40)),
    });
    expect(kinds(r)).toContain("highGusts");
    expect(r.call).toBe("good");
    expect(r.call).toBe(base.call);
    expect(r.score).toBe(base.score);
    expect(r.unpenalizedScore).toBe(base.unpenalizedScore);
    expect(r.reasons.filter((x) => x.kind !== "highGusts")).toEqual(base.reasons);
  });

  it("a warning never lifts or lowers another call", () => {
    const gusty = (h: ModelHour) => (h.gustMph = 40);
    const gustyFlyable = evalWith({ hour: hourWith((h) => ((h.capeJkg = 600), gusty(h))) });
    const plainFlyable = evalWith({ hour: hourWith((h) => (h.capeJkg = 600)) });
    expect(kinds(gustyFlyable)).toContain("highGusts");
    expect(gustyFlyable.call).toBe("flyable");
    expect(gustyFlyable.score).toBe(plainFlyable.score);
    const noGo = evalWith({ hour: hourWith((h) => ((h.precipMm = 1), gusty(h))) });
    expect(kinds(noGo)).toContain("highGusts");
    expect(noGo.call).toBe("noGo");
  });
});

describe("high gusts warning", () => {
  // TEST_LIMITS.gustFactorMph is 6, so the warning threshold is 3 x 6 = 18 mph over the 10 mph wind.
  it("fires at exactly 3x the gust-factor limit and not just below it", () => {
    expect(d.highGustWarningFactorMultiple).toBe(3);
    const at = evalWith({ hour: hourWith((h) => (h.gustMph = 28)) });
    expect(kinds(at)).toContain("highGusts");
    expect(kinds(at).filter((k) => k !== "highGusts")).toEqual(kinds(PERFECT));
    const warning = at.reasons.find((x) => x.kind === "highGusts");
    expect(warning?.severity).toBe("warning");
    expect(warning?.text).toMatch(/^high gusts possible/);
    expect(at.call).toBe("good");
    expect(at.score).toBe(PERFECT.score);
    expect(kinds(evalWith({ hour: hourWith((h) => (h.gustMph = 27.9)) }))).not.toContain("highGusts");
  });

  it("uses max(gust h, gust h+1)", () => {
    expect(kinds(evalWith({ next: nextWith((h) => (h.gustMph = 28)) }))).toContain("highGusts");
  });

  it("follows the multiple in the defaults", () => {
    const custom: ScoringDefaults = { ...d, highGustWarningFactorMultiple: 2 };
    expect(kinds(evalWith({ hour: hourWith((h) => (h.gustMph = 22)) }, custom))).toContain("highGusts");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.gustMph = 21.9)) }, custom))).not.toContain(
      "highGusts",
    );
  });

  it("a gust below the 10 m wind doesn't warn", () => {
    const limits: WindLimits = { ...TEST_LIMITS, gustFactorMph: 0.1 };
    const r = evalWith({
      siteLimits: limits,
      hour: hourWith((h) => (h.gustMph = 8)),
      next: nextWith((h) => (h.gustMph = 8)),
    });
    expect(kinds(r)).not.toContain("highGusts");
  });

  it("falls back to the default gust-factor limit when the limits omit it", () => {
    const limits: WindLimits = { minMph: 5, idealMph: 10, maxMph: 18 };
    expect(DEFAULT_WIND_LIMITS.gustFactorMph).toBe(5);
    const threshold = 10 + 3 * DEFAULT_WIND_LIMITS.gustFactorMph;
    expect(
      kinds(evalWith({ siteLimits: limits, hour: hourWith((h) => (h.gustMph = threshold)) })),
    ).toContain("highGusts");
    expect(
      kinds(evalWith({ siteLimits: limits, hour: hourWith((h) => (h.gustMph = threshold - 0.1)) })),
    ).not.toContain("highGusts");
  });

  it("launch limits override the site limits", () => {
    const launch = makeLaunch({ limits: { minMph: 5, idealMph: 10, maxMph: 18, gustFactorMph: 2 } });
    expect(kinds(evalWith({ launch, hour: hourWith((h) => (h.gustMph = 16)) }))).toContain("highGusts");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.gustMph = 16)) }))).not.toContain("highGusts");
  });

  it("a peak launch computes against the 10 m wind, not the interpolated launch wind", () => {
    // Launch at 3500 m, between Z700 (3100) and Z600 (4400): interpolated 20 mph from 270.
    const launch = makeLaunch({
      elevationM: 3500,
      limits: { minMph: 0, idealMph: 15, maxMph: 30, gustFactorMph: 5 },
    });
    const hour = perfectHour()
      .with((h) => (h.gustMph = 25))
      .level(700, (l) => (l.windMph = 20))
      .level(600, (l) => ((l.windMph = 20), (l.windDir = 270)))
      .build();
    const lw = launchWind(hour, elevationM(launch));
    expect(lw?.speedMph).toBeCloseTo(20, 6);
    // 25 - 10 (10 m) = 15 = 3 x 5, while 25 - 20 would be only 5.
    expect(kinds(evalWith({ launch, hour }))).toContain("highGusts");
  });
});

describe("neighbor check, mixed cases", () => {
  it("uses RRFS when its center and a neighbor are present", () => {
    const neighbors = calmNeighbors().points.map((p) =>
      p.bearingDeg === 180 ? { ...p, rrfs: nw(12, 0), ecmwf: nw(10, 270) } : p,
    );
    const r = evalWith({ neighbors });
    expect(r.call).toBe("noGo");
    const reason = r.reasons.find((x) => x.kind === "neighborWindStrong");
    expect(reason?.text).toContain("5 mi S: N 12 mph (RRFS)");
  });

  it("uses RRFS even when ECMWF disagrees and RRFS is calm", () => {
    const neighbors = calmNeighbors().points.map((p) =>
      p.bearingDeg === 180 ? { ...p, ecmwf: nw(12, 0) } : p,
    );
    expect(evalWith({ neighbors }).call).toBe("good");
  });

  it("falls back to ECMWF when the RRFS center wind is undefined", () => {
    const neighbors = calmNeighbors().points.map((p) =>
      p.bearingDeg === 90 ? { ...p, ecmwf: nw(12, 0), rrfs: nw(12, 180) } : p,
    );
    const center: NeighborSample = { ecmwf: nw(10, 270), rrfs: nw(undefined, 270) };
    const r = evalWith({ neighborCenter: center, neighbors });
    const reason = r.reasons.find((x) => x.kind === "neighborWindStrong");
    expect(reason?.text).toContain("5 mi E: N 12 mph (ECMWF)");
  });

  it("falls back to ECMWF when every RRFS neighbor is undefined", () => {
    const neighbors = calmNeighbors().points.map((p) => ({
      ...p,
      rrfs: undefined,
      ecmwf: p.bearingDeg === 0 ? nw(8, 350) : p.ecmwf,
    }));
    const r = evalWith({ neighbors });
    expect(r.reasons.find((x) => x.kind === "neighborWind")?.text).toContain("(ECMWF)");
  });

  it("skips undefined RRFS neighbors and still checks the others", () => {
    const neighbors = calmNeighbors().points.map((p) => {
      if (p.bearingDeg === 0) return { ...p, rrfs: undefined };
      if (p.bearingDeg === 90) return { ...p, rrfs: nw(10, undefined) };
      if (p.bearingDeg === 270) return { ...p, rrfs: nw(15, 90) };
      return p;
    });
    const r = evalWith({ neighbors });
    expect(r.call).toBe("noGo");
    expect(r.reasons.find((x) => x.kind === "neighborWindStrong")?.text).toContain("5 mi W: E 15 mph (RRFS)");
  });

  it("names the worst neighbor", () => {
    const neighbors = calmNeighbors().points.map((p) => {
      if (p.bearingDeg === 0) return { ...p, rrfs: nw(8, 340) };
      if (p.bearingDeg === 180) return { ...p, rrfs: nw(8, 355) };
      return p;
    });
    const r = evalWith({ neighbors });
    expect(r.reasons.filter((x) => x.kind === "neighborWind")).toHaveLength(1);
    expect(r.reasons.find((x) => x.kind === "neighborWind")?.text).toContain("5 mi S: N 8 mph");
  });

  it("all undefined gives n/a", () => {
    const empty: NeighborSample = { ecmwf: undefined, rrfs: undefined };
    const r = evalWith({
      neighborCenter: empty,
      neighbors: calmNeighbors().points.map((p) => ({ bearingDeg: p.bearingDeg })),
    });
    expect(kinds(r)).toContain("neighborUnavailable");
    expect(r.call).toBe("good");
  });

  it("a peak launch with a strong westerly launch wind and 10 m winds matching the neighbors is not flagged", () => {
    const launch = makeLaunch({
      elevationM: 3500,
      limits: { minMph: 0, idealMph: 15, maxMph: 30, gustFactorMph: 20 },
    });
    const hour = perfectHour()
      .with((h) => ((h.windMph = 8), (h.windDir = 90), (h.gustMph = 10)))
      .level(700, (l) => (l.windMph = 20))
      .level(600, (l) => ((l.windMph = 20), (l.windDir = 270)))
      .build();
    const lw = launchWind(hour, elevationM(launch));
    expect(lw?.speedMph).toBeCloseTo(20, 6);
    expect(lw?.dirDeg).toBeCloseTo(270, 6);
    const center: NeighborSample = { ecmwf: nw(8, 90), rrfs: nw(8, 90) };
    const neighbors = [0, 90, 180, 270].map((bearingDeg) => ({
      bearingDeg,
      ecmwf: nw(8, 95),
      rrfs: nw(8, 85),
    }));
    const r = evalWith({ launch, hour, neighborCenter: center, neighbors });
    expect(kinds(r)).not.toContain("neighborWind");
    expect(kinds(r)).not.toContain("neighborWindStrong");
    expect(r.call).not.toBe("noGo");
  });

  it("applies to RRFS's own evaluation too", () => {
    expect(kinds(evalWith({ model: "rrfs", neighbors: rrfsNeighborAt(180, nw(12, 0)) }))).toContain(
      "neighborWindStrong",
    );
  });
});

describe("the other model sees storms", () => {
  const stormy = hourWith((h) => (h.precipMm = 1)).build();

  it("caps the ECMWF hour at flyable, not no-go", () => {
    const r = evalWith({ other: { hour: stormy, next: undefined } });
    expect(r.call).toBe("flyable");
    expect(kinds(r)).toContain("rrfsSeesStorms");
  });

  it("uses RRFS's h+1 too", () => {
    const next = nextWith((h) => (h.precipMm = 0.25)).build();
    const r = evalWith({ other: { hour: perfectHour().build(), next } });
    expect(kinds(r)).toContain("rrfsSeesStorms");
  });

  it("is raised on precipitation only, not on RRFS gusts", () => {
    const gusty = hourWith((h) => (h.gustMph = 45)).build();
    const r = evalWith({ other: { hour: gusty, next: undefined } });
    expect(kinds(r)).not.toContain("rrfsSeesStorms");
    expect(r.call).toBe("good");
  });

  it("is not raised when RRFS is calm or missing", () => {
    expect(evalWith({ other: { hour: perfectHour().build(), next: undefined } }).call).toBe("good");
    expect(evalWith({ other: { hour: undefined, next: undefined } }).call).toBe("good");
  });

  it("is ECMWF sees storms when RRFS is evaluated against ECMWF", () => {
    const r = evalWith({ model: "rrfs", other: { hour: stormy, next: undefined } });
    expect(kinds(r)).not.toContain("rrfsSeesStorms");
    expect(kinds(r)).toContain("ecmwfSeesStorms");
    expect(r.reasons.find((x) => x.kind === "ecmwfSeesStorms")?.text).toBe("ECMWF sees storms");
    expect(r.call).toBe("flyable");
  });

  it("is never ECMWF sees storms when evaluating ECMWF", () => {
    const r = evalWith({ other: { hour: stormy, next: undefined } });
    expect(kinds(r)).not.toContain("ecmwfSeesStorms");
    expect(r.reasons.find((x) => x.kind === "rrfsSeesStorms")?.text).toBe("RRFS sees storms");
  });

  it("is not applied without the other model", () => {
    for (const model of ["ecmwf", "rrfs"] as const) {
      const r = evalWith({ model });
      expect(kinds(r)).not.toContain("rrfsSeesStorms");
      expect(kinds(r)).not.toContain("ecmwfSeesStorms");
      expect(r.call).toBe("good");
    }
  });
});

describe("storm look-ahead", () => {
  /** Evaluates a series in order, with each hour's `next`. */
  function series(builders: HourBuilder[]): { hours: ModelHour[]; results: HourResult[] } {
    const hours = builders.map((b, i) => b.with((h) => (h.time = REFERENCE_TIME + i * HOUR_MS)).build());
    const results = hours.map((hour, i) => evaluateHour(ctx({ hour, next: hours[i + 1], last: hours[i + 1] === undefined })));
    return { hours, results };
  }

  function stormAt(i: number, n: number, cape: number): HourBuilder[] {
    return Array.from({ length: n }, (_, k) =>
      k === i ? perfectHour().with((h) => ((h.precipMm = 1), (h.capeJkg = cape))) : perfectHour(),
    );
  }

  function marked(results: HourResult[]): number[] {
    return results.flatMap((r, i) => (kinds(r).includes("stormsComing") ? [i] : []));
  }

  it("marks exactly the 2 hours before the first convective no-go", () => {
    // Precip recorded at index 4 falls in flying hour 3 too (max(h, h+1)), so hours 3 and 4 are
    // no-go; hour 3 is convective via max(CAPE 3, CAPE 4) = 300.
    const { hours, results } = series(stormAt(4, 7, 300));
    expect(results.map((r) => r.call)).toEqual([
      "good",
      "good",
      "good",
      "noGo",
      "noGo",
      "good",
      "good",
    ]);
    const out = applyStormLookahead(results, hours);
    expect(marked(out)).toEqual([1, 2]);
    const reason = out[1]?.reasons.find((x) => x.kind === "stormsComing");
    expect(reason?.text).toBe(`storms forecast by ${formatDenverTime(REFERENCE_TIME + 3 * HOUR_MS)}`);
    expect(reason?.severity).toBe("caution");
  });

  it("gusts alone are not convective, even with high CAPE", () => {
    const builders = Array.from({ length: 5 }, (_, k) =>
      k === 3 ? perfectHour().with((h) => ((h.gustMph = 45), (h.capeJkg = 900))) : perfectHour(),
    );
    const { hours, results } = series(builders);
    expect(results.map((r) => r.call)).not.toContain("noGo");
    expect(marked(applyStormLookahead(results, hours))).toEqual([]);
  });

  it("does not mark when CAPE is under 200", () => {
    const { hours, results } = series(stormAt(4, 7, 199));
    expect(marked(applyStormLookahead(results, hours))).toEqual([]);
  });

  it("CAPE exactly 200 is convective", () => {
    const { hours, results } = series(stormAt(4, 7, 200));
    expect(marked(applyStormLookahead(results, hours))).toEqual([1, 2]);
  });

  it("a non-precip no-go is not convective even with high CAPE", () => {
    const builders = Array.from({ length: 5 }, (_, k) =>
      k === 3 ? perfectHour().with((h) => ((h.windMph = 25), (h.capeJkg = 900))) : perfectHour(),
    );
    const { hours, results } = series(builders);
    expect(marked(applyStormLookahead(results, hours))).toEqual([]);
  });

  it("a marked hour becomes flyable and its score drops by the caution penalty", () => {
    const { hours, results } = series(stormAt(4, 7, 300));
    const out = applyStormLookahead(results, hours);
    expect(results[2]?.call).toBe("good");
    expect(out[2]?.call).toBe("flyable");
    expect((results[2]?.score ?? 0) - (out[2]?.score ?? 0)).toBe(d.cautionReasonPenalty);
  });

  it("leaves no-go hours unchanged", () => {
    const builders = stormAt(4, 7, 300);
    builders[2] = perfectHour().with((h) => (h.windMph = 25));
    const { hours, results } = series(builders);
    const out = applyStormLookahead(results, hours);
    expect(out[2]).toEqual(results[2]);
    expect(out[3]).toEqual(results[3]);
    expect(marked(out)).toEqual([1]);
  });

  it("does not mutate its input", () => {
    const { hours, results } = series(stormAt(4, 7, 300));
    const before = JSON.stringify(results);
    applyStormLookahead(results, hours);
    expect(JSON.stringify(results)).toBe(before);
  });

  it("is idempotent: a second pass changes nothing", () => {
    const { hours, results } = series(stormAt(4, 7, 300));
    const once = applyStormLookahead(results, hours);
    expect(marked(once)).toEqual([1, 2]);
    expect(applyStormLookahead(once, hours)).toEqual(once);
  });

  it("handles a convective hour at index 0 or 1", () => {
    const at0 = series(stormAt(0, 4, 300));
    expect(marked(applyStormLookahead(at0.results, at0.hours))).toEqual([]);
    // Precip at index 1 makes hours 0 and 1 no-go; nothing before 0 to mark.
    const at1 = series(stormAt(1, 4, 300));
    expect(marked(applyStormLookahead(at1.results, at1.hours))).toEqual([]);
    // Precip at index 2 makes hour 1 the first convective no-go; only hour 0 is before it.
    const at2 = series(stormAt(2, 4, 300));
    expect(marked(applyStormLookahead(at2.results, at2.hours))).toEqual([0]);
  });

  it("the last hour works with next undefined", () => {
    const { hours, results } = series(stormAt(4, 5, 300));
    expect(results[4]?.call).toBe("noGo");
    const out = applyStormLookahead(results, hours);
    expect(marked(out)).toEqual([1, 2]);
    // A last-hour storm with no h+1 uses CAPE at h alone. Each hour is evaluated without a next,
    // so the storm doesn't spill into hour 0 and only the last hour's own CAPE decides.
    const lastOnly = (cape: number) => {
      const hours = [
        perfectHour().build(),
        perfectHour(REFERENCE_TIME + HOUR_MS).with((h) => ((h.precipMm = 1), (h.capeJkg = cape))).build(),
      ];
      const results = hours.map((hour) => evaluateHour(ctx({ hour, last: true })));
      return marked(applyStormLookahead(results, hours));
    };
    expect(lastOnly(300)).toEqual([0]);
    expect(lastOnly(199)).toEqual([]);
  });

  it("names the nearest storm when two are in range", () => {
    // Precip recorded at 3 and 4. Precip uses max(h, h+1), so hour 2 is a no-go too; the storms
    // start at 2.
    const builders = Array.from({ length: 6 }, (_, k) =>
      k === 3 || k === 4
        ? perfectHour().with((h) => ((h.precipMm = 1), (h.capeJkg = 300)))
        : perfectHour(),
    );
    const { hours, results } = series(builders);
    const out = applyStormLookahead(results, hours);
    expect(marked(out)).toEqual([0, 1]);
    expect(out[1]?.reasons.find((x) => x.kind === "stormsComing")?.text).toBe(
      `storms forecast by ${formatDenverTime(REFERENCE_TIME + 2 * HOUR_MS)}`,
    );
  });

  it("matches hours by time, so a missing hour isn't skipped over", () => {
    // Drop hour 2 of the series: hour 3 is the first convective no-go. Hour 1 is two hours before
    // it and is marked; hour 0 is three hours before it, though it's only two results back.
    const { hours, results } = series(stormAt(4, 7, 300));
    const gapped = <T extends { time: number }>(xs: readonly T[]): T[] =>
      xs.filter((x) => x.time !== REFERENCE_TIME + 2 * HOUR_MS);
    const out = applyStormLookahead(gapped(results), gapped(hours));
    expect(out.map((r) => (r.time - REFERENCE_TIME) / HOUR_MS)).toEqual([0, 1, 3, 4, 5, 6]);
    expect(marked(out)).toEqual([1]);
    expect(out[1]?.reasons.find((x) => x.kind === "stormsComing")?.text).toBe(
      `storms forecast by ${formatDenverTime(REFERENCE_TIME + 3 * HOUR_MS)}`,
    );
  });

  it("keeps the input order", () => {
    const { hours, results } = series(stormAt(4, 7, 300));
    const out = applyStormLookahead([...results].reverse(), [...hours].reverse());
    expect(out.map((r) => r.time)).toEqual([...results].reverse().map((r) => r.time));
    expect(marked([...out].reverse())).toEqual([1, 2]);
  });

  it("ignores no-data hours", () => {
    const builders = stormAt(4, 7, 300);
    builders[2] = perfectHour().with((h) => (h.windMph = undefined));
    const { hours, results } = series(builders);
    const out = applyStormLookahead(results, hours);
    expect(out[2]).toEqual(results[2]);
    expect(marked(out)).toEqual([1]);
  });
});

describe("wrapping arc", () => {
  const launch = makeLaunch({ ok: [{ from: 330, to: 30 }], ideal: [{ from: 350, to: 10 }] });
  const aloftNorth = (dir: number) =>
    hourWith((h) => (h.windDir = dir))
      .level(700, (l) => (l.windDir = 0))
      .level(600, (l) => (l.windDir = 0));

  it("ideal across north is good", () => {
    expect(evalWith({ launch, hour: aloftNorth(0) }).call).toBe("good");
    expect(evalWith({ launch, hour: aloftNorth(355) }).call).toBe("good");
  });

  it("in ok but not ideal across north is flyable", () => {
    const r = evalWith({ launch, hour: aloftNorth(20) });
    expect(r.call).toBe("flyable");
    expect(kinds(r)).toContain("directionNotIdeal");
  });

  it("outside the wrapping ok arc is no-go", () => {
    expect(kinds(evalWith({ launch, hour: aloftNorth(40) }))).toContain("wrongDirection");
    expect(kinds(evalWith({ launch, hour: aloftNorth(320) }))).toContain("wrongDirection");
  });

  it("over the back is judged against the wrapping arc", () => {
    const back = hourWith((h) => (h.windDir = 0)).level(700, (l) => ((l.windMph = 22), (l.windDir = 180)));
    expect(kinds(evalWith({ launch, hour: back }))).toContain("overTheBack");
    const front = hourWith((h) => (h.windDir = 0)).level(700, (l) => ((l.windMph = 22), (l.windDir = 10)));
    expect(kinds(evalWith({ launch, hour: front }))).not.toContain("overTheBack");
  });
});

describe("ideal-arc fallback", () => {
  it("an empty ideal makes anywhere in ok ideal", () => {
    const launch = makeLaunch({ ideal: [] });
    const r = evalWith({ launch, hour: hourWith((h) => (h.windDir = 230)) });
    expect(r.call).toBe("good");
    expect(kinds(r)).not.toContain("directionNotIdeal");
    expect(r.unpenalizedScore).toBe(PERFECT.unpenalizedScore);
  });

  it("an empty ideal doesn't widen ok", () => {
    const launch = makeLaunch({ ideal: [] });
    expect(kinds(evalWith({ launch, hour: hourWith((h) => (h.windDir = 220)) }))).toContain("wrongDirection");
  });

  it("a zero-width ideal arc is that heading plus or minus 15 degrees", () => {
    const launch = makeLaunch({ ideal: [{ from: 270, to: 270 }] });
    for (const dir of [255, 270, 285]) {
      const r = evalWith({ launch, hour: hourWith((h) => (h.windDir = dir)) });
      expect(r.call, String(dir)).toBe("good");
      expect(r.unpenalizedScore, String(dir)).toBe(PERFECT.unpenalizedScore);
    }
    for (const dir of [254, 286]) {
      const r = evalWith({ launch, hour: hourWith((h) => (h.windDir = dir)) });
      expect(r.call, String(dir)).toBe("flyable");
      expect(kinds(r), String(dir)).toContain("directionNotIdeal");
      expect(r.unpenalizedScore, String(dir)).toBe(PERFECT.unpenalizedScore - d.idealDirectionBonus);
    }
  });

  it("a zero-width ideal arc across north wraps", () => {
    const launch = makeLaunch({ ok: [{ from: 300, to: 60 }], ideal: [{ from: 0, to: 0 }] });
    const at = (dir: number) =>
      evalWith({
        launch,
        hour: hourWith((h) => (h.windDir = dir)).level(700, (l) => (l.windDir = 0)).level(600, (l) => (l.windDir = 0)),
      });
    expect(at(345).call).toBe("good");
    expect(at(15).call).toBe("good");
    expect(kinds(at(16))).toContain("directionNotIdeal");
  });

  it("zero-width arcs are expanded one by one in a mixed list", () => {
    const launch = makeLaunch({ ideal: [{ from: 240, to: 240 }, { from: 290, to: 300 }] });
    expect(evalWith({ launch, hour: hourWith((h) => (h.windDir = 230)) }).call).toBe("good");
    expect(evalWith({ launch, hour: hourWith((h) => (h.windDir = 295)) }).call).toBe("good");
    expect(kinds(evalWith({ launch, hour: hourWith((h) => (h.windDir = 270)) }))).toContain(
      "directionNotIdeal",
    );
  });
});

describe("score", () => {
  it("orders ideal > ok direction > near max", () => {
    const ideal = PERFECT.score;
    const okDir = evalWith({ hour: hourWith((h) => (h.windDir = 240)) }).score;
    const nearMax = evalWith({ hour: hourWith((h) => ((h.windMph = 17), (h.gustMph = 18))) }).score;
    expect(ideal).toBeGreaterThan(okDir);
    expect(okDir).toBeGreaterThan(nearMax);
  });

  it("wind bonus peaks at the ideal speed and falls off toward min and max", () => {
    const at = (mph: number) =>
      evalWith({ hour: hourWith((h) => ((h.windMph = mph), (h.gustMph = mph))) }).unpenalizedScore;
    expect(at(10)).toBeGreaterThan(at(8));
    expect(at(8)).toBeGreaterThan(at(6));
    expect(at(10)).toBeGreaterThan(at(13));
    expect(at(13)).toBeGreaterThan(at(15));
  });

  it("uses the midpoint of min and max when no ideal speed is given", () => {
    const limits: WindLimits = { minMph: 4, maxMph: 16, gustFactorMph: 6 };
    const at = (mph: number) =>
      evalWith({ siteLimits: limits, hour: hourWith((h) => ((h.windMph = mph), (h.gustMph = mph))) })
        .unpenalizedScore;
    expect(at(10)).toBe(PERFECT.unpenalizedScore);
    expect(at(10)).toBeGreaterThan(at(8));
    expect(at(10)).toBeGreaterThan(at(12));
  });

  it("better thermals, a deeper boundary layer and a higher base score higher", () => {
    const weakTI = evalWith({ hour: perfectHour().level(600, (l) => (l.tempC = -5)) });
    expect(PERFECT.score).toBeGreaterThan(weakTI.score);
    const shallow = evalWith({ hour: hourWith((h) => (h.blhM = 1400)) });
    expect(PERFECT.score).toBeGreaterThan(shallow.score);
    const lowBase = evalWith({ hour: hourWith((h) => (h.dewpointC = 15)) }); // 625 m, about 2050 ft
    expect(PERFECT.score).toBeGreaterThan(lowBase.score);
  });

  it("more caution reasons score lower", () => {
    const one = evalWith({ hour: hourWith((h) => (h.capeJkg = 600)) });
    const two = evalWith({ hour: hourWith((h) => ((h.capeJkg = 600), (h.lowCloudPct = 70))) });
    expect(one.score).toBeGreaterThan(two.score);
  });

  it("is clamped to 0-100", () => {
    const harsh: ScoringDefaults = { ...d, cautionReasonPenalty: 150 };
    const low = evalWith({ hour: hourWith((h) => (h.capeJkg = 600)) }, harsh);
    expect(low.call).toBe("flyable");
    expect(low.score).toBe(d.minScore);
    const generous: ScoringDefaults = { ...d, baseScore: 90 };
    expect(evalWith({}, generous).score).toBe(d.maxScore);
  });

  it("storm look-ahead recomputes from the unclamped score, not the clamped one", () => {
    // Base 90 puts the perfect hour at 140 unclamped (100 shown). With the storm reason it's
    // 135, still clamped to 100; subtracting from the shown 100 would wrongly give 95.
    const generous: ScoringDefaults = { ...d, baseScore: 90 };
    // Precip recorded at index 2 makes hour 1 a convective no-go (max(CAPE 1, CAPE 2) = 300).
    const hours = [perfectHour(), perfectHour(), perfectHour().with((h) => ((h.precipMm = 1), (h.capeJkg = 300)))].map(
      (b, i) => b.with((h) => (h.time = REFERENCE_TIME + i * HOUR_MS)).build(),
    );
    const results = hours.map((hour, i) => evaluateHour(ctx({ hour, next: hours[i + 1], last: hours[i + 1] === undefined }), generous));
    expect(results[0]?.score).toBe(d.maxScore);
    const out = applyStormLookahead(results, hours, generous);
    expect(kinds(out[0] as HourResult)).toContain("stormsComing");
    expect(out[0]?.call).toBe("flyable");
    expect(out[0]?.score).toBe(d.maxScore);
  });
});

describe("Nov 7 2026 at Golden North (gusts not scored)", () => {
  // Good 11:00-16:00 with weak, intermittently soarable lift. ECMWF hours from Open-Meteo's
  // past-days data, Denver time: [hour, 10 m wind mph, dir deg, gust mph, BLH m]. The old
  // gust-factor rule capped every one of these at flyable (gust factor 9-13 mph over a limit of 5).
  const OBSERVED: [number, number, number, number, number][] = [
    [10, 3, 3, 12, 770],
    [11, 3, 37, 12, 1010],
    [12, 6, 80, 16, 750],
    [13, 7, 86, 18, 610],
    [14, 5, 83, 18, 600],
    [15, 3, 67, 13, 575],
  ];
  // 2026-11-07 is MST (UTC-7).
  const denver = (h: number, m = 0): number => Date.UTC(2026, 10, 7, h + 7, m);

  const golden = sites.find((s) => s.id === "rmhpa/golden-lookout-mountain");
  const north = golden?.launches.find((l) => l.id === "rmhpa/golden-lookout-mountain/north");

  const hours = OBSERVED.map(([h, windMph, windDir, gustMph, blhM]) =>
    perfectHour(denver(h))
      .with((x) => {
        x.windMph = windMph;
        x.windDir = windDir;
        x.gustMph = gustMph;
        x.blhM = blhM;
        x.capeJkg = 0;
        x.precipMm = 0;
      })
      .build(),
  );

  function evaluate(): HourResult[] {
    if (golden === undefined || north === undefined) throw new Error("Golden North not in the bundled sites");
    return hours.map((hour, i) => {
      const wind = { time: hour.time, windMph: hour.windMph, windDir: hour.windDir };
      return evaluateHour({
        model: "ecmwf",
        hour,
        next: hours[i + 1],
        other: undefined,
        neighborCenter: { ecmwf: wind },
        neighbors: [0, 90, 180, 270].map((bearingDeg) => ({ bearingDeg, ecmwf: wind })),
        launch: north,
        site: golden,
      });
    });
  }

  it("uses the bundled launch and the right Denver hours", () => {
    expect(north?.elevationFt).toBe(6770);
    expect(north?.directions).toEqual({ ok: [{ from: 0, to: 135 }], ideal: [{ from: 45, to: 90 }] });
    expect(north?.limits ?? golden?.limits).toEqual({ minMph: 0, maxMph: 15, idealMph: 7, gustFactorMph: 5 });
    expect(hours.map((h) => formatDenverTime(h.time))).toEqual([
      "10:00", "11:00", "12:00", "13:00", "14:00", "15:00",
    ]);
    // The launch is below Z700, so the launch wind is the 10 m wind.
    for (const h of hours) {
      expect(launchWind(h, elevationM(north as Launch))).toEqual({ speedMph: h.windMph, dirDeg: h.windDir });
    }
  });

  it("every hour is good, with no gust reason or warning", () => {
    const results = evaluate();
    expect(results.map((r) => r.call)).toEqual(Array(6).fill("good"));
    for (const r of results) {
      expect(r.reasons.filter((x) => /gust/i.test(x.text)), formatDenverTime(r.time)).toEqual([]);
      expect(r.reasons.filter((x) => x.severity === "caution" || x.severity === "noGo")).toEqual([]);
    }
  });

  it("gives a 10:00-16:00 window", () => {
    const day = { sunrise: denver(6, 35), sunset: denver(16, 50) };
    const window = findBestWindow(daylightHours(evaluate(), day, denver(7)), new Map());
    expect(window).toBeDefined();
    expect(windowLabel(window as FlyingWindow)).toBe("10:00–16:00");
  });
});

describe("effectiveIdealArcs", () => {
  it("falls back to the ok arcs when there are no ideal arcs", () => {
    expect(effectiveIdealArcs(makeLaunch({ ok: OK, ideal: [] }), d)).toEqual(OK);
  });

  it("widens a zero-width arc by the half-width on each side", () => {
    const half = d.zeroWidthIdealHalfWidthDeg;
    const arcs = effectiveIdealArcs(makeLaunch({ ideal: [{ from: 200, to: 200 }] }), d);
    expect(arcs).toEqual([{ from: 200 - half, to: 200 + half }]);
  });

  it("leaves a normal arc unchanged", () => {
    expect(effectiveIdealArcs(makeLaunch({ ideal: IDEAL }), d)).toEqual(IDEAL);
  });
});
