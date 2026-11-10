import { describe, expect, it } from "vitest";
import { arcsContain } from "../../../src/core/sites/degreeArc";
import type { Launch, Site, WindLimits } from "../../../src/core/sites/site";
import { bundledSiteProvider } from "../../../src/core/sites/siteProvider";

/** Sanity checks on the real curated sites.json. */
const sites: Site[] = await bundledSiteProvider().sites();

function allLimits(site: Site): WindLimits[] {
  return [site.limits, ...site.launches.flatMap((l) => (l.limits === undefined ? [] : [l.limits]))];
}

/** Each id prefix and the host its sites are curated from. */
const SOURCE_HOSTS: Readonly<Record<string, string>> = {
  rmhpa: "www.rmhpa.org",
  pawnee: "pawneeparagliding.com",
};

function inRange(x: number, lo: number, hi: number): boolean {
  return x >= lo && x <= hi;
}

describe("sites.json", () => {
  it("hasAll26SitesWithUniqueIds", () => {
    expect(sites.length).toBe(26);
    expect(new Set(sites.map((s) => s.id)).size).toBe(sites.length);
    const launchIds = sites.flatMap((s) => s.launches.map((l) => l.id));
    expect(new Set(launchIds).size).toBe(launchIds.length);
    for (const site of sites) {
      const prefix = site.id.split("/")[0] ?? "";
      expect(Object.keys(SOURCE_HOSTS), site.id).toContain(prefix);
      expect(new URL(site.sourceURL).host, site.id).toBe(SOURCE_HOSTS[prefix]);
      for (const launch of site.launches) {
        expect(launch.id.startsWith(`${site.id}/`), launch.id).toBe(true);
      }
    }
  });

  it("hasCleanIds", () => {
    const re = /^(rmhpa|pawnee)\/[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)?$/;
    for (const site of sites) {
      expect(site.id).toMatch(re);
      for (const launch of site.launches) expect(launch.id).toMatch(re);
    }
  });

  it("everySiteHasALaunchWithPlausibleLocation", () => {
    for (const site of sites) {
      expect(site.launches.length, site.id).toBeGreaterThan(0);
      for (const l of site.launches) {
        expect(inRange(l.coordinate.latitude, 36, 42), l.id).toBe(true);
        expect(inRange(l.coordinate.longitude, -110, -101), l.id).toBe(true);
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
        if (limits.gustFactorMph !== undefined) {
          expect(limits.gustFactorMph, site.id).toBeGreaterThan(0);
        }
      }
    }
  });

  it("idealSpeedMissingOnlyWherePageGivesNone", () => {
    const missing = sites.filter((s) => s.limits.idealMph === undefined).map((s) => s.id).sort();
    expect(missing).toEqual([
      "pawnee/indian-caves",
      "pawnee/pony-ridge",
      "pawnee/the-buttes",
      "rmhpa/aspen",
      "rmhpa/blodgett-open-space",
    ]);
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
