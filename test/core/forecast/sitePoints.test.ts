import { describe, expect, it } from "vitest";
import { SHARED_POINT_MAX_DROP_FT, sitePoints } from "../../../src/core/forecast/sitePoints";
import { bundledSiteProvider } from "../../../src/core/sites/siteProvider";
import type { Launch } from "../../../src/core/sites/site";
import { testLaunch } from "../../support/builders";

function launch(id: string, latitude: number, longitude: number, elevationFt: number): Launch {
  return testLaunch({ id, name: id, coordinate: { latitude, longitude }, elevationFt });
}

describe("sitePoints", () => {
  it("givesOnePointToASingleLaunch", () => {
    const result = sitePoints([launch("a", 40, -105, 7000)]);
    expect(result.points).toEqual([{ coordinate: { latitude: 40, longitude: -105 }, elevationFt: 7000 }]);
    expect(result.pointOf).toEqual([0]);
  });

  it("throwsOnAnEmptyList", () => {
    expect(() => sitePoints([])).toThrow();
  });

  it("anchorsOnTheHighestLaunchEvenWhenListedLast", () => {
    const result = sitePoints([launch("low", 40, -105, 9500), launch("high", 40.01, -105.01, 10000)]);
    expect(result.points[0]).toEqual({ coordinate: { latitude: 40.01, longitude: -105.01 }, elevationFt: 10000 });
    expect(result.pointOf).toEqual([0, 0]);
  });

  it("picksTheFirstListedOnATie", () => {
    const result = sitePoints([launch("first", 40, -105, 8000), launch("second", 41, -106, 8000)]);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.coordinate).toEqual({ latitude: 40, longitude: -105 });
    expect(result.pointOf).toEqual([0, 0]);
  });

  it("sharesAtTheThresholdAndSplitsJustBelowIt", () => {
    expect(SHARED_POINT_MAX_DROP_FT).toBe(1000);
    const result = sitePoints([
      launch("anchor", 40, -105, 10000),
      launch("exactly", 40.1, -105.1, 9000),
      launch("below", 40.2, -105.2, 8999),
    ]);
    expect(result.points).toEqual([
      { coordinate: { latitude: 40, longitude: -105 }, elevationFt: 10000 },
      { coordinate: { latitude: 40.2, longitude: -105.2 }, elevationFt: 8999 },
    ]);
    expect(result.pointOf).toEqual([0, 0, 1]);
  });

  it("mergesFarLaunchesAtTheSameCoordinateAndElevation", () => {
    const result = sitePoints([
      launch("anchor", 40, -105, 10000),
      launch("x", 40.1, -105.1, 8000),
      launch("y", 40.1, -105.1, 8000),
    ]);
    expect(result.points).toHaveLength(2);
    expect(result.pointOf).toEqual([0, 1, 1]);
  });

  it("keepsFarLaunchesAtDifferentCoordinatesApart", () => {
    const result = sitePoints([
      launch("anchor", 40, -105, 10000),
      launch("x", 40.1, -105.1, 8000),
      launch("y", 40.2, -105.2, 8000),
    ]);
    expect(result.points).toHaveLength(3);
    expect(result.pointOf).toEqual([0, 1, 2]);
  });

  it("ordersPointsAnchorThenExtrasInLaunchOrder", () => {
    const result = sitePoints([
      launch("far1", 40.1, -105.1, 8000),
      launch("anchor", 40, -105, 10000),
      launch("near", 40.3, -105.3, 9800),
      launch("far2", 40.2, -105.2, 7000),
    ]);
    expect(result.points.map((p) => p.elevationFt)).toEqual([10000, 8000, 7000]);
    expect(result.pointOf).toEqual([1, 0, 0, 2]);
  });

  describe("catalog", () => {
    async function openSites() {
      return (await bundledSiteProvider().sites()).filter((s) => s.status.state === "open" && s.launches.length > 0);
    }

    // A failure here after a sites.json edit is a catalog change, not a bug.
    it("pinsTheMultiPointSites", async () => {
      const sites = await openSites();
      const pointCount = (id: string): number => {
        const site = sites.find((s) => s.id === id);
        if (!site) throw new Error(`no site ${id}`);
        return sitePoints(site.launches).points.length;
      };
      expect(pointCount("rmhpa/williams-peak")).toBe(2);
      expect(pointCount("bhgc/petersen-mountain-rainbow-ridge")).toBe(2);
      expect(pointCount("rmhpa/boulder-wonderland")).toBe(1);
    });

    it("sharesPointsAcrossTheCatalog", async () => {
      const sites = await openSites();
      const launchTotal = sites.reduce((n, s) => n + s.launches.length, 0);
      const pointTotal = sites.reduce((n, s) => n + sitePoints(s.launches).points.length, 0);
      expect(pointTotal).toBeLessThan(launchTotal);
    });
  });
});
