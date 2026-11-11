import { describe, expect, it } from "vitest";
import { arcsContain, normalizedDegrees } from "../../../src/core/sites/degreeArc";
import type { DegreeArc, Launch, Site, WindLimits } from "../../../src/core/sites/site";
import { bundledSiteProvider, bundledSources } from "../../../src/core/sites/siteProvider";
import rawSites from "../../../sites.json";

/** Sanity checks on the real curated sites.json. */
const sites: Site[] = await bundledSiteProvider().sites();

function allLimits(site: Site): WindLimits[] {
  return [site.limits, ...site.launches.flatMap((l) => (l.limits === undefined ? [] : [l.limits]))];
}

const sources = bundledSources();
const sourceHosts = new Map(sources.map((s) => [s.id, new URL(s.url).host]));

function inRange(x: number, lo: number, hi: number): boolean {
  return x >= lo && x <= hi;
}

function launchById(id: string): Launch {
  const found = sites.flatMap((s) => s.launches).find((l) => l.id === id);
  if (found === undefined) throw new Error(`no launch ${id}`);
  return found;
}

/** The bearing halfway along an arc, going clockwise from `from` to `to`. */
function arcMidpoint(arc: DegreeArc): number {
  return normalizedDegrees(arc.from + normalizedDegrees(arc.to - arc.from) / 2);
}

const KITING_IDS = ["manual/circle-park", "manual/foothills-community-park", "manual/carstens-park"];

describe("sites.json", () => {
  it("hasAll38SitesWithUniqueIds", () => {
    expect(sites.length).toBe(38);
    expect(new Set(sites.map((s) => s.id)).size).toBe(sites.length);
    const launchIds = sites.flatMap((s) => s.launches.map((l) => l.id));
    expect(new Set(launchIds).size).toBe(launchIds.length);
    for (const site of sites) {
      const prefix = site.id.split("/")[0] ?? "";
      expect([...sourceHosts.keys()], site.id).toContain(prefix);
      expect(new URL(site.sourceURL).host, site.id).toBe(sourceHosts.get(prefix));
      for (const launch of site.launches) {
        expect(launch.id.startsWith(`${site.id}/`), launch.id).toBe(true);
      }
    }
  });

  it("hasCleanIds", () => {
    const re = /^[a-z0-9]+\/[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)?$/;
    for (const site of sites) {
      expect(site.id).toMatch(re);
      for (const launch of site.launches) expect(launch.id).toMatch(re);
    }
  });

  it("everySourceHasSites", () => {
    for (const source of sources) {
      expect(sites.some((s) => s.id.startsWith(`${source.id}/`)), source.id).toBe(true);
    }
  });

  it("everySiteHasALaunchWithPlausibleLocation", () => {
    for (const site of sites) {
      expect(site.launches.length, site.id).toBeGreaterThan(0);
      for (const l of site.launches) {
        // The contiguous US.
        expect(inRange(l.coordinate.latitude, 24, 50), l.id).toBe(true);
        expect(inRange(l.coordinate.longitude, -125, -66), l.id).toBe(true);
        expect(inRange(l.elevationFt, 4000, 14500), l.id).toBe(true);
      }
    }
  });

  it("limitsAreConsistent", () => {
    for (const site of sites) {
      for (const limits of allLimits(site)) {
        expect(limits.minMph, site.id).toBeLessThan(limits.maxMph);
        if (limits.idealMph !== undefined) {
          expect(inRange(limits.idealMph, limits.minMph, limits.maxMph), site.id).toBe(true);
        }
        if (limits.idealMaxMph !== undefined) {
          expect(limits.idealMph, site.id).toBeDefined();
          expect(inRange(limits.idealMaxMph, limits.idealMph ?? 0, limits.maxMph), site.id).toBe(true);
        }
        if (limits.gustFactorMph !== undefined) {
          expect(limits.gustFactorMph, site.id).toBeGreaterThan(0);
        }
      }
    }
  });

  // Curator-only fields (limitsSource) aren't parsed, so this reads the raw JSON.
  it("idealSpeedMissingOnlyWherePageGivesNone", () => {
    for (const site of rawSites.sites) {
      if (site.limits.idealMph === undefined) {
        expect(["default", "page-prose"], site.id).toContain(site.limitsSource);
      }
    }
  });

  it("arcBoundsAreNormalized", () => {
    for (const site of sites) {
      for (const l of site.launches) {
        for (const arc of [...l.directions.ok, ...l.directions.ideal]) {
          expect(arc.from >= 0 && arc.from < 360, l.id).toBe(true);
          expect(arc.to >= 0 && arc.to < 360, l.id).toBe(true);
        }
      }
    }
  });

  it("openSitesWithoutDirectionsHaveNotes", () => {
    for (const site of sites) {
      if (site.status.state !== "open") continue;
      for (const l of site.launches) {
        if (l.directions.ok.length === 0) {
          expect((site.notes ?? "").length, l.id).toBeGreaterThan(0);
        }
      }
    }
  });

  it("closedSites", () => {
    const closed = sites.filter((s) => s.status.state !== "open").map((s) => s.id).sort();
    expect(closed).toEqual(["rmhpa/blodgett-open-space", "rmhpa/copper-mountain", "rmhpa/wolcott"]);
  });

  // Ids differ from Swift: "boulder---wonderland" is now "boulder-wonderland", etc.
  it("proseArcsGoTheShortWay", () => {
    function launch(id: string): Launch {
      const found = sites.flatMap((s) => s.launches).find((l) => l.id === id);
      if (found === undefined) throw new Error(`no launch ${id}`);
      return found;
    }
    const bellyache = launch("rmhpa/bellyache/main");
    expect(arcsContain(bellyache.directions.ok, 90)).toBe(true);
    expect(arcsContain(bellyache.directions.ok, 270)).toBe(false);
    const boulder = launch("rmhpa/boulder-wonderland/upper");
    expect(arcsContain(boulder.directions.ok, 90)).toBe(true);
    expect(arcsContain(boulder.directions.ok, 270)).toBe(false);
    const golden = launch("rmhpa/golden-lookout-mountain/north");
    expect(arcsContain(golden.directions.ok, 0)).toBe(true);
    expect(arcsContain(golden.directions.ok, 180)).toBe(false);
    const ponySouth = launch("pawnee/pony-ridge/south");
    expect(arcsContain(ponySouth.directions.ideal, 225)).toBe(true);
    expect(arcsContain(ponySouth.directions.ideal, 45)).toBe(false);
    const buttes = launch("pawnee/the-buttes/main");
    expect(arcsContain(buttes.directions.ok, 90)).toBe(true);
    expect(arcsContain(buttes.directions.ok, 270)).toBe(false);
  });

  // Judgment calls the author made on 2026-11-08 (see the notes in the JSON).
  it("authorDirectionDecisions", () => {
    function launch(id: string): Launch {
      const found = sites.flatMap((s) => s.launches).find((l) => l.id === id);
      if (found === undefined) throw new Error(`no launch ${id}`);
      return found;
    }
    const bellyache = launch("rmhpa/bellyache/main").directions.ok;
    expect(arcsContain(bellyache, 340)).toBe(true);
    expect(arcsContain(bellyache, 330)).toBe(false);
    const walshes = launch("rmhpa/aspen/walshes").directions.ok;
    expect(arcsContain(walshes, 105)).toBe(true);
    expect(arcsContain(walshes, 110)).toBe(false);
    const ruthies = launch("rmhpa/aspen/ruthies").directions.ok;
    expect(arcsContain(ruthies, 255)).toBe(true);
    expect(arcsContain(ruthies, 250)).toBe(false);
    // Read from OpenTopoMap contours on 2026-11-09: the faces look about 245 and 130.
    const pawneeWest = launch("pawnee/pawnee-west/main").directions;
    expect(arcsContain(pawneeWest.ok, 200)).toBe(true);
    expect(arcsContain(pawneeWest.ok, 300)).toBe(false);
    expect(arcsContain(pawneeWest.ideal, 245)).toBe(true);
    const section15 = launch("pawnee/section-15/main").directions;
    expect(arcsContain(section15.ok, 90)).toBe(true);
    expect(arcsContain(section15.ok, 270)).toBe(false);
    expect(arcsContain(section15.ideal, 130)).toBe(true);
  });

  // BHGC gives no direction for these, so they're terrain estimates from 2026-11-09 (see the notes in the JSON).
  it("bhgcTerrainDirections", () => {
    function launch(id: string): Launch {
      const found = sites.flatMap((s) => s.launches).find((l) => l.id === id);
      if (found === undefined) throw new Error(`no launch ${id}`);
      return found;
    }
    // Duck Hill, McClellan and Spooner wrap through north.
    const duckHill = launch("bhgc/duck-hill/main").directions.ok;
    expect(arcsContain(duckHill, 0)).toBe(true);
    expect(arcsContain(duckHill, 180)).toBe(false);
    const mcclellan = launch("bhgc/mcclellan/main").directions.ok;
    expect(arcsContain(mcclellan, 0)).toBe(true);
    expect(arcsContain(mcclellan, 180)).toBe(false);
    const spooner = launch("bhgc/spooner/main").directions;
    expect(arcsContain(spooner.ok, 0)).toBe(true);
    expect(arcsContain(spooner.ideal, 0)).toBe(true);
    expect(arcsContain(spooner.ok, 180)).toBe(false);
    // Peavine faces read from the contours, not the script's estimate of 9.
    const bowl = launch("bhgc/peavine-mt/bowl").directions.ok;
    expect(arcsContain(bowl, 67.5)).toBe(true);
    expect(arcsContain(bowl, 0)).toBe(false);
    const tower = launch("bhgc/peavine-mt/tower").directions.ok;
    expect(arcsContain(tower, 90)).toBe(true);
    expect(arcsContain(tower, 9)).toBe(false);
  });

  it("kitingSitesAreTheThreeParks", () => {
    expect(sites.filter((s) => s.kind === "kiting").map((s) => s.id).sort()).toEqual([...KITING_IDS].sort());
    for (const site of sites) {
      if (!KITING_IDS.includes(site.id)) expect(site.kind, site.id).toBe("flying");
    }
  });

  it("kitingSitesHaveKitingLimitsAndNoSoaringOrXc", () => {
    for (const site of sites.filter((s) => s.kind === "kiting")) {
      expect(site.soaring, site.id).toBeUndefined();
      expect(site.xc, site.id).toBeUndefined();
      expect(site.rating, site.id).toBe("Unrated");
      expect(site.launches.length, site.id).toBe(1);
      for (const limits of allLimits(site)) {
        expect(limits.idealMph, site.id).toBeDefined();
        expect(limits.idealMaxMph, site.id).toBeDefined();
        expect(limits.idealMaxMph ?? Infinity, site.id).toBeLessThanOrEqual(limits.maxMph);
      }
    }
    // Curator-only fields aren't parsed, so this reads the raw JSON.
    for (const site of rawSites.sites.filter((s) => "kind" in s && s.kind === "kiting")) {
      expect(site.limitsSource, site.id).toBe("author");
    }
  });

  // The author's directions from issue #14 (2026-11-11). Circle Park's arcs wrap through north.
  it("kitingParkDirections", () => {
    const circle = launchById("manual/circle-park/field").directions;
    expect(arcsContain(circle.ok, 0)).toBe(true);
    expect(arcsContain(circle.ok, 250)).toBe(true);
    expect(arcsContain(circle.ok, 240)).toBe(false);
    expect(arcsContain(circle.ok, 30)).toBe(false);
    expect(arcsContain(circle.ideal, 300)).toBe(true);
    expect(arcsContain(circle.ideal, 0)).toBe(true);
    expect(arcsContain(circle.ideal, 260)).toBe(false);
    const foothills = launchById("manual/foothills-community-park/field").directions;
    expect(arcsContain(foothills.ok, 0)).toBe(true);
    expect(arcsContain(foothills.ok, 100)).toBe(true);
    expect(arcsContain(foothills.ok, 120)).toBe(false);
    const carstens = launchById("manual/carstens-park/bowl").directions;
    expect(arcsContain(carstens.ok, 200)).toBe(true);
    expect(arcsContain(carstens.ok, 240)).toBe(false);
  });

  it("kitingIdealArcsSitInsideTheirOkArcs", () => {
    for (const site of sites.filter((s) => s.kind === "kiting")) {
      for (const launch of site.launches) {
        const { ok, ideal } = launch.directions;
        expect(ideal.length, launch.id).toBeGreaterThan(0);
        for (const arc of ideal) {
          expect(arcsContain(ok, arcMidpoint(arc)), launch.id).toBe(true);
          expect(arcsContain(ok, arc.from), launch.id).toBe(true);
          expect(arcsContain(ok, arc.to), launch.id).toBe(true);
        }
      }
    }
  });

  it("lists only real launches under soaring, and Boulder and Golden are not ridge sites", () => {
    for (const site of sites) {
      for (const id of site.soaring?.launchIds ?? []) {
        expect(site.launches.map((l) => l.id), site.id).toContain(id);
      }
    }
    // RMHPA's Boulder page doesn't call it soarable and its Golden page says little ridge soaring.
    for (const id of ["rmhpa/boulder-wonderland", "rmhpa/golden-lookout-mountain"]) {
      expect(sites.find((s) => s.id === id)?.soaring, id).toBeUndefined();
    }
  });
});
