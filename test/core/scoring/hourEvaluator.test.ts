import { describe, expect, it } from "vitest";
import type { ModelHour, NeighborWind } from "../../../src/core/forecast/models";
import { SCORING_DEFAULTS, lowCloudBaseMarginalM } from "../../../src/core/scoring/defaults";
import type { ScoringDefaults } from "../../../src/core/scoring/defaults";
import { cloudBaseAboveLaunchM, launchWind, thermalIndex } from "../../../src/core/scoring/derived";
import {
  REASON_KIND_ORDER,
  REASON_SEVERITY,
  applyStormLookahead,
  evaluateHour,
} from "../../../src/core/scoring/hourEvaluator";
import type {
  HourContext,
  HourResult,
  NeighborPointSample,
  NeighborSample,
  ReasonKind,
} from "../../../src/core/scoring/hourEvaluator";
import type { DegreeArc, Launch, Site, WindLimits } from "../../../src/core/sites/site";
import { DEFAULT_WIND_LIMITS, elevationM } from "../../../src/core/sites/site";
import { formatDenverTime } from "../../../src/core/time";
import { METERS_PER_FOOT } from "../../../src/core/units";
import {
  PERFECT_LAUNCH_ELEVATION_M,
  REFERENCE_TIME,
  perfectHour,
} from "../../support/hourBuilder";
import type { HourBuilder } from "../../support/hourBuilder";

const HOUR_MS = 3_600_000;
const d = SCORING_DEFAULTS;

/** Limits that put the perfect hour's 10 mph at ideal, with a min > 0. */
const LIMITS: WindLimits = { minMph: 5, idealMph: 10, maxMph: 18, gustFactorMph: 6 };
const OK: DegreeArc[] = [{ from: 225, to: 315 }];
const IDEAL: DegreeArc[] = [{ from: 250, to: 290 }];

interface LaunchOptions {
  elevationM?: number;
  ok?: DegreeArc[];
  ideal?: DegreeArc[];
  limits?: WindLimits;
}

function makeLaunch(o: LaunchOptions = {}): Launch {
  const launch: Launch = {
    id: "test/site/launch",
    name: "Test launch",
    coordinate: { latitude: 39.5, longitude: -106 },
    elevationFt: (o.elevationM ?? PERFECT_LAUNCH_ELEVATION_M) / METERS_PER_FOOT,
    directions: { ok: o.ok ?? OK, ideal: o.ideal ?? IDEAL },
  };
  if (o.limits !== undefined) launch.limits = o.limits;
  return launch;
}

function makeSite(launch: Launch, limits: WindLimits = LIMITS): Site {
  return {
    id: "test/site",
    name: "Test site",
    sourceURL: "https://example.com",
    rating: "P2",
    status: { state: "open" },
    launches: [launch],
    limits,
  };
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

function kinds(r: HourResult): ReasonKind[] {
  return r.reasons.map((x) => x.kind);
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
  it("is declared no-go kinds first, then marginal, then info", () => {
    const rank = { noGo: 0, marginal: 1, info: 2 } as const;
    const ranks = REASON_KIND_ORDER.map((k) => rank[REASON_SEVERITY[k]]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
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
  it("the perfect hour is flyable with no marginal or no-go reasons and a high score", () => {
    expect(PERFECT.call).toBe("flyable");
    expect(PERFECT.reasons.filter((x) => x.severity !== "info")).toEqual([]);
    expect(PERFECT.score).toBeGreaterThanOrEqual(80);
    expect(PERFECT.time).toBe(REFERENCE_TIME);
    expect(PERFECT.launchWind).toEqual({ speedMph: 10, dirDeg: 270 });
  });
});

describe("no-go rules", () => {
  const cases: [string, CtxOptions, ReasonKind][] = [
    ["precipitation", { hour: hourWith((h) => (h.precipMm = 1)) }, "precipitation"],
    ["gusts", { hour: hourWith((h) => (h.gustMph = 30)) }, "gusts"],
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

describe("marginal rules", () => {
  const cases: [string, CtxOptions, ReasonKind][] = [
    ["gust factor", { hour: hourWith((h) => (h.gustMph = 17)) }, "gustFactor"],
    ["direction not ideal", { hour: hourWith((h) => (h.windDir = 240)) }, "directionNotIdeal"],
    ["near max", { hour: hourWith((h) => (h.windMph = 17)) }, "nearMaxWind"],
    ["not curated", { launch: makeLaunch({ ok: [], ideal: [] }) }, "notCurated"],
    ["overdevelopment", { hour: hourWith((h) => (h.capeJkg = 800)) }, "overdevelopment"],
    ["aloft", { hour: perfectHour().level(700, (l) => (l.windMph = 28)) }, "aloftWind"],
    ["low cloud base", { hour: hourWith((h) => (h.dewpointC = 19)) }, "lowCloud"],
    ["low cloud cover", { hour: hourWith((h) => (h.lowCloudPct = 80)) }, "lowCloud"],
    ["neighbor", { neighbors: rrfsNeighborAt(180, nw(8, 350)) }, "neighborWind"],
    ["pre-thermal", { hour: hourWith((h) => (h.blhM = 300)).level(600, (l) => (l.tempC = 0)) }, "preThermal"],
    [
      "RRFS sees storms",
      { other: { hour: hourWith((h) => (h.precipMm = 2)).build(), next: undefined } },
      "rrfsSeesStorms",
    ],
  ];
  for (const [name, o, kind] of cases) {
    it(name, () => {
      const r = evalWith(o);
      expect(r.call).toBe("marginal");
      expect(kinds(r)).toContain(kind);
      expect(r.score).toBeLessThan(PERFECT.score);
    });
  }
});

describe("boundaries", () => {
  it("precipitation 0.24 / 0.25 mm in hour h", () => {
    expect(kinds(evalWith({ hour: hourWith((h) => (h.precipMm = 0.24)) }))).not.toContain("precipitation");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.precipMm = 0.25)) }))).toContain("precipitation");
  });

  it("precipitation in h+1 only", () => {
    expect(evalWith({ next: nextWith((h) => (h.precipMm = 0.24)) }).call).toBe("flyable");
    const r = evalWith({ next: nextWith((h) => (h.precipMm = 0.25)) });
    expect(r.call).toBe("noGo");
    expect(kinds(r)).toContain("precipitation");
  });

  it("gust 24.9 / 25 mph in hour h (24.9 is only a gust-factor marginal)", () => {
    const below = evalWith({ hour: hourWith((h) => (h.gustMph = 24.9)) });
    expect(below.call).toBe("marginal");
    expect(kinds(below)).not.toContain("gusts");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.gustMph = 25)) }))).toContain("gusts");
  });

  it("gust in h+1 only", () => {
    expect(kinds(evalWith({ next: nextWith((h) => (h.gustMph = 24.9)) }))).not.toContain("gusts");
    const r = evalWith({ next: nextWith((h) => (h.gustMph = 25)) });
    expect(r.call).toBe("noGo");
    expect(kinds(r)).toContain("gusts");
  });

  it("max wind: exactly max is not no-go, just over is", () => {
    const at = evalWith({ hour: hourWith((h) => ((h.windMph = 18), (h.gustMph = 18))) });
    expect(at.call).toBe("marginal");
    expect(kinds(at)).toEqual(expect.arrayContaining(["nearMaxWind"]));
    expect(kinds(at)).not.toContain("windTooStrong");
    const over = evalWith({ hour: hourWith((h) => ((h.windMph = 18.1), (h.gustMph = 18.1))) });
    expect(over.call).toBe("noGo");
    expect(kinds(over)).toContain("windTooStrong");
    expect(kinds(over)).not.toContain("nearMaxWind");
  });

  it("near max: max - 2 is marginal, just below is not", () => {
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

  it("below 4 mph there is no ideal bonus and no not-ideal marginal", () => {
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
    expect(at(24).call).toBe("flyable");
    expect(kinds(at(25))).toContain("aloftWind");
    expect(at(25).call).toBe("marginal");
    expect(at(34).call).toBe("marginal");
    expect(kinds(at(34))).not.toContain("strongAloft");
    expect(at(35).call).toBe("noGo");
    expect(kinds(at(35))).toContain("strongAloft");
    expect(kinds(at(35))).not.toContain("aloftWind");
  });

  it("over the back 19 / 20 mph", () => {
    const at = (mph: number) =>
      evalWith({ hour: perfectHour().level(700, (l) => ((l.windMph = mph), (l.windDir = 90))) });
    expect(at(19).call).toBe("flyable");
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
    expect(cloudBaseAboveLaunchM(below)).toBeLessThan(lowCloudBaseMarginalM());
    expect(cloudBaseAboveLaunchM(at)).toBeGreaterThanOrEqual(lowCloudBaseMarginalM());
    expect(kinds(evalWith({ launch, hour: below }))).toContain("lowCloud");
    expect(kinds(evalWith({ launch, hour: at }))).not.toContain("lowCloud");
  });

  it("low cloud cover 59 / 60 %", () => {
    expect(kinds(evalWith({ hour: hourWith((h) => (h.lowCloudPct = 59)) }))).not.toContain("lowCloud");
    expect(kinds(evalWith({ hour: hourWith((h) => (h.lowCloudPct = 60)) }))).toContain("lowCloud");
  });

  it("neighbor 60 / 61 degrees (neighbor < 10 mph)", () => {
    expect(evalWith({ neighbors: rrfsNeighborAt(180, nw(9.9, 330)) }).call).toBe("flyable");
    const r = evalWith({ neighbors: rrfsNeighborAt(180, nw(9.9, 331)) });
    expect(r.call).toBe("marginal");
    expect(kinds(r)).toContain("neighborWind");
  });

  it("neighbor 90 / 91 degrees (neighbor < 10 mph)", () => {
    const at90 = evalWith({ neighbors: rrfsNeighborAt(180, nw(9.9, 0)) });
    expect(at90.call).toBe("marginal");
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
    expect(evalWith({ neighbors: rrfsNeighborAt(180, nw(4.9, 90)) }).call).toBe("flyable");
    expect(evalWith({ neighbors: rrfsNeighborAt(180, nw(5, 90)) }).call).toBe("noGo");
    const weakCenter: NeighborSample = { ecmwf: nw(10, 270), rrfs: nw(4.9, 270) };
    expect(
      evalWith({ neighborCenter: weakCenter, neighbors: rrfsNeighborAt(180, nw(12, 90)) }).call,
    ).toBe("flyable");
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
    expect(kinds(evalWith({ launch, hour: hourFor(499, 0.1) }))).toContain("preThermal");
    expect(kinds(evalWith({ launch, hour: hourFor(500, 0.1) }))).not.toContain("preThermal");
    expect(kinds(evalWith({ launch, hour: hourFor(499, 0) }))).not.toContain("preThermal");
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
    expect(evalWith({ next: nextWith((h) => (h.precipMm = undefined)) }).call).toBe("flyable");
    const r = evalWith({
      hour: hourWith((h) => (h.precipMm = 1)),
      next: nextWith((h) => (h.precipMm = undefined)),
    });
    expect(kinds(r)).toContain("precipitation");
  });

  it("the last hour (no next) uses hour h alone", () => {
    expect(evalWith({ last: true }).call).toBe("flyable");
    expect(kinds(evalWith({ last: true, hour: hourWith((h) => (h.gustMph = 30)) }))).toContain("gusts");
  });

  it("undefined gust in both hours skips the gust rules with n/a", () => {
    const r = evalWith({
      hour: hourWith((h) => (h.gustMph = undefined)),
      next: nextWith((h) => (h.gustMph = undefined)),
    });
    expect(r.call).toBe("flyable");
    expect(kinds(r)).toContain("gustUnavailable");
    expect(kinds(r)).not.toContain("gusts");
    expect(kinds(r)).not.toContain("gustFactor");
    expect(r.reasons.find((x) => x.kind === "gustUnavailable")?.text).toMatch(/n\/a/);
  });

  it("a gust present in only one of h and h+1 is still checked", () => {
    const r = evalWith({
      hour: hourWith((h) => (h.gustMph = undefined)),
      next: nextWith((h) => (h.gustMph = 30)),
    });
    expect(kinds(r)).toContain("gusts");
    expect(kinds(r)).not.toContain("gustUnavailable");
  });

  it("pre-thermal with only BLH", () => {
    const noTI = (b: HourBuilder) =>
      b.level(600, (l) => (l.tempC = undefined)).level(500, (l) => (l.tempC = undefined));
    const low = noTI(hourWith((h) => (h.blhM = 400))).build();
    expect(thermalIndex(low, PERFECT_LAUNCH_ELEVATION_M)).toBeUndefined();
    expect(kinds(evalWith({ hour: low }))).toEqual(
      expect.arrayContaining(["preThermal", "thermalIndexUnavailable"]),
    );
    expect(kinds(evalWith({ hour: noTI(hourWith((h) => (h.blhM = 600))) }))).not.toContain("preThermal");
  });

  it("pre-thermal with only TI", () => {
    const warm = hourWith((h) => (h.blhM = undefined)).level(600, (l) => (l.tempC = 0));
    expect(kinds(evalWith({ hour: warm }))).toEqual(
      expect.arrayContaining(["preThermal", "blhUnavailable"]),
    );
    expect(kinds(evalWith({ hour: hourWith((h) => (h.blhM = undefined)) }))).not.toContain("preThermal");
  });

  it("pre-thermal with neither BLH nor TI is skipped as n/a", () => {
    const r = evalWith({
      hour: hourWith((h) => (h.blhM = undefined))
        .level(600, (l) => (l.tempC = undefined))
        .level(500, (l) => (l.tempC = undefined)),
    });
    expect(kinds(r)).not.toContain("preThermal");
    expect(kinds(r)).toEqual(expect.arrayContaining(["blhUnavailable", "thermalIndexUnavailable"]));
    expect(r.call).toBe("flyable");
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
    expect(r.call).toBe("flyable");
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
  it("a 10 mph wind and a 25 mph tailwind aloft are marginal 'not curated', not no-go", () => {
    const r = evalWith({
      launch: makeLaunch({ ok: [], ideal: [] }),
      hour: hourWith((h) => (h.windDir = 90)).level(700, (l) => ((l.windMph = 25), (l.windDir = 90))),
    });
    expect(r.call).toBe("marginal");
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

describe("gust factor", () => {
  it("over the limit is marginal and costs exactly gustFactorPenalty (not also the generic penalty)", () => {
    const custom: ScoringDefaults = { ...d, gustFactorPenalty: 7, marginalReasonPenalty: 5 };
    const base = evalWith({}, custom);
    const r = evalWith({ hour: hourWith((h) => (h.gustMph = 16.5)) }, custom);
    expect(kinds(r)).toEqual(["gustFactor"]);
    expect(r.call).toBe("marginal");
    expect(base.score - r.score).toBe(7);
  });

  it("at the limit is not marginal", () => {
    // 16 - 10 = 6 = the limit
    expect(kinds(evalWith({ hour: hourWith((h) => (h.gustMph = 16)) }))).not.toContain("gustFactor");
  });

  it("uses max(gust h, gust h+1)", () => {
    expect(kinds(evalWith({ next: nextWith((h) => (h.gustMph = 17)) }))).toContain("gustFactor");
  });

  it("is never no-go on its own, however large", () => {
    const limits: WindLimits = { ...LIMITS, gustFactorMph: 1 };
    const r = evalWith({ siteLimits: limits, hour: hourWith((h) => (h.gustMph = 24)) });
    expect(r.call).toBe("marginal");
    expect(r.reasons.filter((x) => x.severity === "noGo")).toEqual([]);
  });

  it("a gust below the 10 m wind counts as 0", () => {
    const limits: WindLimits = { ...LIMITS, gustFactorMph: 0 };
    const r = evalWith({
      siteLimits: limits,
      hour: hourWith((h) => (h.gustMph = 8)),
      next: nextWith((h) => (h.gustMph = 8)),
    });
    expect(kinds(r)).not.toContain("gustFactor");
  });

  it("falls back to the default gust-factor limit when the limits omit it", () => {
    const limits: WindLimits = { minMph: 5, idealMph: 10, maxMph: 18 };
    expect(DEFAULT_WIND_LIMITS.gustFactorMph).toBe(5);
    const def = 10 + (DEFAULT_WIND_LIMITS.gustFactorMph ?? 0);
    expect(kinds(evalWith({ siteLimits: limits, hour: hourWith((h) => (h.gustMph = def)) }))).not.toContain(
      "gustFactor",
    );
    expect(
      kinds(evalWith({ siteLimits: limits, hour: hourWith((h) => (h.gustMph = def + 0.1)) })),
    ).toContain("gustFactor");
  });

  it("a peak launch computes against the 10 m wind, not the interpolated launch wind", () => {
    // Launch at 3500 m, between Z700 (3100) and Z600 (4400): interpolated 20 mph from 270.
    const launch = makeLaunch({
      elevationM: 3500,
      limits: { minMph: 0, idealMph: 15, maxMph: 30, gustFactorMph: 5 },
    });
    const hour = perfectHour()
      .with((h) => (h.gustMph = 16))
      .level(700, (l) => (l.windMph = 20))
      .level(600, (l) => ((l.windMph = 20), (l.windDir = 270)))
      .build();
    const lw = launchWind(hour, elevationM(launch));
    expect(lw?.speedMph).toBeCloseTo(20, 6);
    // 16 - 10 (10 m) = 6 > 5, while 16 - 20 would clamp to 0.
    expect(kinds(evalWith({ launch, hour }))).toContain("gustFactor");
  });

  it("launch limits override the site limits", () => {
    const launch = makeLaunch({ limits: { minMph: 0, idealMph: 10, maxMph: 25, gustFactorMph: 6 } });
    const r = evalWith({ launch, hour: hourWith((h) => ((h.windMph = 20), (h.gustMph = 21))) });
    expect(kinds(r)).not.toContain("windTooStrong");
    expect(r.call).toBe("flyable");
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
    expect(evalWith({ neighbors }).call).toBe("flyable");
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
    expect(r.call).toBe("flyable");
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

describe("RRFS sees storms", () => {
  const stormy = hourWith((h) => (h.gustMph = 30)).build();

  it("caps the ECMWF hour at marginal, not no-go", () => {
    const r = evalWith({ other: { hour: stormy, next: undefined } });
    expect(r.call).toBe("marginal");
    expect(kinds(r)).toContain("rrfsSeesStorms");
  });

  it("uses RRFS's h+1 too", () => {
    const next = nextWith((h) => (h.precipMm = 0.25)).build();
    const r = evalWith({ other: { hour: perfectHour().build(), next } });
    expect(kinds(r)).toContain("rrfsSeesStorms");
  });

  it("is not raised when RRFS is calm or missing", () => {
    expect(evalWith({ other: { hour: perfectHour().build(), next: undefined } }).call).toBe("flyable");
    expect(evalWith({ other: { hour: undefined, next: undefined } }).call).toBe("flyable");
  });

  it("is not applied when evaluating RRFS", () => {
    const r = evalWith({ model: "rrfs", other: { hour: stormy, next: undefined } });
    expect(kinds(r)).not.toContain("rrfsSeesStorms");
    expect(r.call).toBe("flyable");
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
      "flyable",
      "flyable",
      "flyable",
      "noGo",
      "noGo",
      "flyable",
      "flyable",
    ]);
    const out = applyStormLookahead(results, hours);
    expect(marked(out)).toEqual([1, 2]);
    const reason = out[1]?.reasons.find((x) => x.kind === "stormsComing");
    expect(reason?.text).toBe(`storms forecast by ${formatDenverTime(REFERENCE_TIME + 3 * HOUR_MS)}`);
    expect(reason?.severity).toBe("marginal");
  });

  it("gust no-gos count too", () => {
    const builders = Array.from({ length: 5 }, (_, k) =>
      k === 3 ? perfectHour().with((h) => ((h.gustMph = 30), (h.capeJkg = 250))) : perfectHour(),
    );
    const { hours, results } = series(builders);
    expect(marked(applyStormLookahead(results, hours))).toEqual([0, 1]);
  });

  it("does not mark when CAPE is under 200", () => {
    const { hours, results } = series(stormAt(4, 7, 199));
    expect(marked(applyStormLookahead(results, hours))).toEqual([]);
  });

  it("CAPE exactly 200 is convective", () => {
    const { hours, results } = series(stormAt(4, 7, 200));
    expect(marked(applyStormLookahead(results, hours))).toEqual([1, 2]);
  });

  it("a non-precip, non-gust no-go is not convective even with high CAPE", () => {
    const builders = Array.from({ length: 5 }, (_, k) =>
      k === 3 ? perfectHour().with((h) => ((h.windMph = 25), (h.capeJkg = 900))) : perfectHour(),
    );
    const { hours, results } = series(builders);
    expect(marked(applyStormLookahead(results, hours))).toEqual([]);
  });

  it("a marked hour becomes marginal and its score drops by the marginal penalty", () => {
    const { hours, results } = series(stormAt(4, 7, 300));
    const out = applyStormLookahead(results, hours);
    expect(results[2]?.call).toBe("flyable");
    expect(out[2]?.call).toBe("marginal");
    expect((results[2]?.score ?? 0) - (out[2]?.score ?? 0)).toBe(d.marginalReasonPenalty);
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
        perfectHour(REFERENCE_TIME + HOUR_MS).with((h) => ((h.gustMph = 30), (h.capeJkg = cape))).build(),
      ];
      const results = hours.map((hour) => evaluateHour(ctx({ hour, last: true })));
      return marked(applyStormLookahead(results, hours));
    };
    expect(lastOnly(300)).toEqual([0]);
    expect(lastOnly(199)).toEqual([]);
  });

  it("names the nearest storm when two are in range", () => {
    // Gust no-gos at 3 and 4 (gusts at h only, so no spill-over into h-1).
    const builders = Array.from({ length: 6 }, (_, k) =>
      k === 3 || k === 4
        ? perfectHour().with((h) => ((h.gustMph = 30), (h.capeJkg = 300)))
        : perfectHour(),
    );
    // Gusts use max(h, h+1), so hour 2 is a gust no-go too; the storms start at 2.
    const { hours, results } = series(builders);
    const out = applyStormLookahead(results, hours);
    expect(marked(out)).toEqual([0, 1]);
    expect(out[1]?.reasons.find((x) => x.kind === "stormsComing")?.text).toBe(
      `storms forecast by ${formatDenverTime(REFERENCE_TIME + 2 * HOUR_MS)}`,
    );
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

  it("ideal across north is flyable", () => {
    expect(evalWith({ launch, hour: aloftNorth(0) }).call).toBe("flyable");
    expect(evalWith({ launch, hour: aloftNorth(355) }).call).toBe("flyable");
  });

  it("in ok but not ideal across north is marginal", () => {
    const r = evalWith({ launch, hour: aloftNorth(20) });
    expect(r.call).toBe("marginal");
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
    expect(r.call).toBe("flyable");
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
      expect(r.call, String(dir)).toBe("flyable");
      expect(r.unpenalizedScore, String(dir)).toBe(PERFECT.unpenalizedScore);
    }
    for (const dir of [254, 286]) {
      const r = evalWith({ launch, hour: hourWith((h) => (h.windDir = dir)) });
      expect(r.call, String(dir)).toBe("marginal");
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
    expect(at(345).call).toBe("flyable");
    expect(at(15).call).toBe("flyable");
    expect(kinds(at(16))).toContain("directionNotIdeal");
  });

  it("zero-width arcs are expanded one by one in a mixed list", () => {
    const launch = makeLaunch({ ideal: [{ from: 240, to: 240 }, { from: 290, to: 300 }] });
    expect(evalWith({ launch, hour: hourWith((h) => (h.windDir = 230)) }).call).toBe("flyable");
    expect(evalWith({ launch, hour: hourWith((h) => (h.windDir = 295)) }).call).toBe("flyable");
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

  it("more marginal reasons score lower", () => {
    const one = evalWith({ hour: hourWith((h) => (h.capeJkg = 600)) });
    const two = evalWith({ hour: hourWith((h) => ((h.capeJkg = 600), (h.lowCloudPct = 70))) });
    expect(one.score).toBeGreaterThan(two.score);
  });

  it("is clamped to 0-100", () => {
    const harsh: ScoringDefaults = { ...d, marginalReasonPenalty: 150 };
    const low = evalWith({ hour: hourWith((h) => (h.capeJkg = 600)) }, harsh);
    expect(low.call).toBe("marginal");
    expect(low.score).toBe(d.minScore);
    const generous: ScoringDefaults = { ...d, baseScore: 90 };
    expect(evalWith({}, generous).score).toBe(d.maxScore);
  });

  it("storm look-ahead recomputes from the unclamped score, not the clamped one", () => {
    // Base 90 puts the perfect hour at 140 unclamped (100 shown). With the storm reason it's
    // 135, still clamped to 100; subtracting from the shown 100 would wrongly give 95.
    const generous: ScoringDefaults = { ...d, baseScore: 90 };
    const hours = [perfectHour(), perfectHour(), perfectHour().with((h) => ((h.gustMph = 30), (h.capeJkg = 300)))].map(
      (b, i) => b.with((h) => (h.time = REFERENCE_TIME + i * HOUR_MS)).build(),
    );
    const results = hours.map((hour, i) => evaluateHour(ctx({ hour, next: hours[i + 1], last: hours[i + 1] === undefined }), generous));
    expect(results[0]?.score).toBe(d.maxScore);
    const out = applyStormLookahead(results, hours, generous);
    expect(kinds(out[0] as HourResult)).toContain("stormsComing");
    expect(out[0]?.call).toBe("marginal");
    expect(out[0]?.score).toBe(d.maxScore);
  });
});
