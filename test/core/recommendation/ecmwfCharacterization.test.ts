import { beforeAll, describe, expect, it } from "vitest";
import type { Transport } from "../../../src/core/forecast/openMeteoClient";
import { createSiteForecastCache } from "../../../src/core/forecast/siteForecastCache";
import { getRecommendations } from "../../../src/core/recommendation/recommendationService";
import type { DaylightRow, RecommendationResult } from "../../../src/core/recommendation/types";
import type { HourResult } from "../../../src/core/scoring/hourEvaluator";
import type { Site } from "../../../src/core/sites/site";
import launchesJSON from "../../fixtures/openmeteo-launches.json?raw";
import neighborsJSON from "../../fixtures/openmeteo-neighbors.json?raw";
import launchesURL from "../../fixtures/openmeteo-launches.url.txt?raw";
import neighborsURL from "../../fixtures/openmeteo-neighbors.url.txt?raw";
import { mapStore } from "../../support/builders";
import { BOULDER, BUTTE, GLENWOOD, fixtureSites } from "../../support/fixtureWeather";

// Pins the ECMWF-primary output (calls, scores, reasons, windows, ranking) of the recorded forecast
// so a change to how the models' roles are chosen can't move it by accident. The snapshot must not
// change except to follow a rename.

/** 2026-11-07 11:00 MST. The fixture covers Nov 7 and Nov 8. */
const NOW = Date.UTC(2026, 10, 7, 18, 0, 0);
const DAYS = ["2026-11-07", "2026-11-08"] as const;

// Hourly index 0 is 2026-11-07 00:00 MST, so Nov 8 07:00 MST (14:00 UTC) is index 31.
const NOV8_0700_MST = 31;
const NOV8_1000_MST = 34;
const NOV8_1600_MST = 40;

let sites: Site[] = [];

beforeAll(async () => {
  sites = await fixtureSites();
});

type Locations = { hourly: Record<string, (number | string | null)[]> }[];

/**
 * The recorded launch response with edits to one site's RRFS hours (the sites are in the order
 * Glenwood, Crested Butte, Boulder).
 */
function editedLaunches(edit: (locations: Locations) => void): string {
  const locations = JSON.parse(launchesJSON) as Locations;
  edit(locations);
  return JSON.stringify(locations);
}

/** Sets the ECMWF precipitation for the hourly indexes from `from` to `to`, inclusive. */
function rainECMWF(location: Locations[number] | undefined, from: number, to: number): void {
  const precip = location?.hourly["precipitation_ecmwf_ifs"];
  if (precip === undefined) throw new Error("no ECMWF precipitation");
  for (let i = from; i <= to; i++) precip[i] = 2;
}

/** Nulls every RRFS field for the hourly indexes from `from` to `to`, inclusive. */
function blankRRFS(location: Locations[number] | undefined, from: number, to: number): void {
  if (location === undefined) throw new Error("no such location");
  for (const [key, values] of Object.entries(location.hourly)) {
    if (!key.endsWith("_ncep_rrfs_conus")) continue;
    for (let i = from; i <= to; i++) values[i] = null;
  }
}

/**
 * The variant, for Nov 8:
 * - Boulder's RRFS is missing for most of the daylight, so its window has no cross-check.
 * - Glenwood's RRFS has a rainy hour at 10:00 MST inside a stretch where ECMWF says good, so
 *   ECMWF's hour carries "RRFS sees storms".
 * - Crested Butte's ECMWF has rain all day (and its RRFS doesn't), so it has no window and
 *   a main reason that only ECMWF's reasons give.
 */
const VARIANT = editedLaunches((locations) => {
  blankRRFS(locations[2], NOV8_1000_MST, NOV8_1600_MST);
  rainECMWF(locations[1], NOV8_0700_MST, NOV8_1600_MST);
  const glenwood = locations[0];
  const precip = glenwood?.hourly["precipitation_ncep_rrfs_conus"];
  if (precip === undefined) throw new Error("no RRFS precipitation");
  precip[NOV8_1000_MST] = 2;
});

async function recommend(launchBody: string, day: string): Promise<RecommendationResult> {
  const transport: Transport = async (url) => {
    if (url === launchesURL.trim()) return { status: 200, body: launchBody };
    if (url === neighborsURL.trim()) return { status: 200, body: neighborsJSON };
    throw new Error(`unexpected request: ${url}`);
  };
  // A fresh cache each time, so runs never share a forecast.
  return getRecommendations(
    { forceRefresh: false, siteIds: sites.map((s) => s.id), day, model: "ecmwf" },
    {
      siteProvider: { sites: async () => sites },
      transport,
      cache: createSiteForecastCache(mapStore()),
      now: () => NOW,
    },
  );
}

/** The row's ECMWF and RRFS sides. The only place the snapshot reads the row's field names. */
function sides(row: DaylightRow): { ecmwf: HourResult; rrfs: HourResult | undefined } {
  return { ecmwf: row.primary.result, rrfs: row.check?.result };
}

function pinHour(r: HourResult | undefined): { call: string; score: number; kinds: string[] } | null {
  return r === undefined ? null : { call: r.call, score: r.score, kinds: r.reasons.map((x) => x.kind) };
}

/** Plain data only, with epoch milliseconds, so the snapshot doesn't depend on the time zone. */
function pin(result: RecommendationResult) {
  return result.sites.map((s) => ({
    id: s.site.id,
    call: s.call,
    mainReason: s.mainReason === undefined ? null : { kind: s.mainReason.kind, text: s.mainReason.text },
    best: s.best === undefined ? null : s.best.launch.id,
    launches: s.launches.map((l) => ({
      id: l.launch.id,
      window:
        l.window === undefined
          ? null
          : {
              start: l.window.start,
              end: l.window.end,
              score: l.window.score,
              confidence: l.window.confidence,
              cautions: l.window.cautions.map((c) => c.kind),
            },
      hours: l.daylight.map((row) => ({
        time: row.time,
        ecmwf: pinHour(sides(row).ecmwf),
        rrfs: pinHour(sides(row).rrfs),
      })),
    })),
  }));
}

describe("ECMWF-primary characterization", () => {
  for (const day of DAYS) {
    it(`pins the recorded forecast for ${day}`, async () => {
      expect(pin(await recommend(launchesJSON, day))).toMatchSnapshot();
    });

    it(`pins the variant (RRFS gap and RRFS storm) for ${day}`, async () => {
      expect(pin(await recommend(VARIANT, day))).toMatchSnapshot();
    });
  }

  it("the variant reaches the paths the snapshot is for", async () => {
    const result = await recommend(VARIANT, "2026-11-08");
    const boulder = result.sites.find((s) => s.site.id === BOULDER);
    const glenwood = result.sites.find((s) => s.site.id === GLENWOOD);
    expect(boulder?.best?.window.confidence).toBe("primaryOnly");

    const stormy = (glenwood?.launches[0]?.daylight ?? []).filter((row) =>
      sides(row).ecmwf.reasons.some((r) => r.kind === "rrfsSeesStorms"),
    );
    expect(stormy.length).toBeGreaterThan(0);
    expect(stormy.every((row) => sides(row).ecmwf.call !== "noGo")).toBe(true);

    // Butte has no window, so its main reason comes from the primary model's hours alone.
    const butte = result.sites.find((s) => s.site.id === BUTTE);
    const reason = butte?.mainReason;
    expect(butte?.best).toBeUndefined();
    expect(reason).toBeDefined();
    const rows = butte?.launches[0]?.daylight ?? [];
    expect(rows.some((row) => sides(row).ecmwf.reasons.some((r) => r.kind === reason?.kind))).toBe(true);
    expect(rows.some((row) => sides(row).rrfs?.reasons.some((r) => r.kind === reason?.kind))).toBe(false);
    // ... and it ranks below the sites that have one.
    const ranked = result.sites.map((s) => s.best !== undefined);
    expect(ranked).toEqual([...ranked].sort((a, b) => Number(b) - Number(a)));
    expect(result.sites.findIndex((s) => s.site.id === BUTTE)).toBeGreaterThan(
      result.sites.findIndex((s) => s.site.id === BOULDER),
    );
  });
});
