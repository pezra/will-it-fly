import { describe, expect, it } from "vitest";
import type { SiteRecommendation } from "../../src/core/recommendation/types";
import type { Site, SiteKind } from "../../src/core/sites/site";
import { startKey } from "../../src/core/travel/driveTime";
import type { KiteMinutes, MaxHours, TravelSettings } from "../../src/ui/travelSettings";
import { listView, placeStart, resolveStart, travelCandidates } from "../../src/ui/useTravel";
import { testLaunch, testSite } from "../support/builders";

const boulder = { latitude: 40.015, longitude: -105.27 };
const aspen = { latitude: 39.19, longitude: -106.82 };

const geolocation: TravelSettings = { start: { kind: "geolocation" }, maxHours: 2, kiteMinutes: 30 };
const place: TravelSettings = {
  start: { kind: "place", name: "Aspen", coordinate: aspen },
  maxHours: 2,
  kiteMinutes: 30,
};

describe("resolveStart", () => {
  it("prefers a chosen place over geolocation", () => {
    expect(resolveStart(place, { status: "found", coordinate: boulder })).toEqual(aspen);
  });
  it("uses a chosen place while geolocation is pending, denied or unavailable", () => {
    expect(resolveStart(place, undefined)).toEqual(aspen);
    expect(resolveStart(place, { status: "denied" })).toEqual(aspen);
    expect(resolveStart(place, { status: "unavailable" })).toEqual(aspen);
  });
  it("uses the found location when no place is chosen", () => {
    expect(resolveStart(geolocation, { status: "found", coordinate: boulder })).toEqual(boulder);
  });
  it("has no start while geolocation is pending, denied or unavailable", () => {
    expect(resolveStart(geolocation, undefined)).toBeUndefined();
    expect(resolveStart(geolocation, { status: "denied" })).toBeUndefined();
    expect(resolveStart(geolocation, { status: "unavailable" })).toBeUndefined();
  });
});

describe("placeStart", () => {
  it("stores the short name", () => {
    expect(
      placeStart({ name: "Boulder, Boulder County, Colorado, United States", coordinate: boulder }),
    ).toEqual({ kind: "place", name: "Boulder", coordinate: boulder });
  });
  it("falls back to the full name, capped, when the short name is empty", () => {
    const name = `, ${"x".repeat(200)}`;
    const start = placeStart({ name, coordinate: boulder });
    expect(start.kind === "place" && start.name).toBe(name.slice(0, 120));
  });
  it("uses a generic name when the name is blank", () => {
    const start = placeStart({ name: "  ", coordinate: boulder });
    expect(start.kind === "place" && start.name).toBe("Chosen place");
  });
  it("caps a long short name", () => {
    const start = placeStart({ name: "y".repeat(200), coordinate: boulder });
    expect(start.kind === "place" && start.name.length).toBe(120);
  });
});

describe("startKey", () => {
  it("is stable under float noise", () => {
    expect(startKey({ latitude: 40.0123, longitude: -105.2712 })).toBe(
      startKey({ latitude: 40.0123000001, longitude: -105.2711999999 }),
    );
    expect(startKey({ latitude: 40.0123, longitude: -105.2712 })).toBe("40.01,-105.27");
  });
  it("changes when the start moves more than the rounding step", () => {
    expect(startKey({ latitude: 40.0123, longitude: -105.2712 })).not.toBe(
      startKey({ latitude: 40.0323, longitude: -105.2712 }),
    );
  });
});

/** A site of `kind` whose launch is `northDeg` degrees of latitude north of Boulder (about 69 mi each). */
function siteNorth(id: string, kind: SiteKind, northDeg: number): Site {
  const coordinate = { latitude: boulder.latitude + northDeg, longitude: boulder.longitude };
  return testSite({ id, kind, launches: [testLaunch({ id: `${id}/launch`, coordinate })] });
}

/**
 * Straight-line miles from Boulder: fly-near 14, kite-near 7, fly-far 138, kite-mid 28, kite-far
 * 69. The prefilter allows 80 mph, so 15 min reaches 20 mi, 30 min 40 mi, 1 h 80 mi and 2 h 160 mi.
 */
const CATALOG: readonly Site[] = [
  siteNorth("fly-near", "flying", 0.2),
  siteNorth("kite-near", "kiting", 0.1),
  siteNorth("fly-far", "flying", 2),
  siteNorth("kite-mid", "kiting", 0.4),
  siteNorth("kite-far", "kiting", 1),
];

function radii(maxHours: MaxHours, kiteMinutes: KiteMinutes): TravelSettings {
  return { start: { kind: "geolocation" }, maxHours, kiteMinutes };
}

function ids(sites: readonly { id: string }[]): string[] {
  return sites.map((s) => s.id);
}

describe("travelCandidates", () => {
  it("keeps only the mode's kind, in catalog order", () => {
    expect(ids(travelCandidates(CATALOG, "flying", boulder, radii(2, 60)))).toEqual(["fly-near", "fly-far"]);
    expect(ids(travelCandidates(CATALOG, "kiting", boulder, radii(2, 60)))).toEqual([
      "kite-near",
      "kite-mid",
      "kite-far",
    ]);
  });
  it("uses the mode's own radius", () => {
    expect(ids(travelCandidates(CATALOG, "flying", boulder, radii(1, 60)))).toEqual(["fly-near"]);
    expect(ids(travelCandidates(CATALOG, "kiting", boulder, radii(4, 30)))).toEqual(["kite-near", "kite-mid"]);
    expect(ids(travelCandidates(CATALOG, "kiting", boulder, radii(4, 15)))).toEqual(["kite-near"]);
  });
  it("gives nothing when no site of the kind is within reach", () => {
    expect(travelCandidates(CATALOG, "kiting", aspen, radii(4, 60))).toEqual([]);
    expect(travelCandidates([], "flying", boulder, radii(4, 60))).toEqual([]);
  });
});

describe("listView", () => {
  const byId = (id: string): Site => CATALOG.find((s) => s.id === id) ?? testSite();
  const rec = (id: string): SiteRecommendation => ({ site: byId(id), call: "noGo", launches: [] });
  // In rank order, as `applyTravel` gives them.
  const shown = [rec("kite-mid"), rec("fly-far"), rec("kite-near")];

  it("shows only the mode's kind, in rank order", () => {
    expect(ids(listView(shown, "kiting", CATALOG, true).shown.map((r) => r.site))).toEqual([
      "kite-mid",
      "kite-near",
    ]);
    expect(ids(listView(shown, "flying", CATALOG, true).shown.map((r) => r.site))).toEqual(["fly-far"]);
  });
  it("counts the total and the hidden sites of the mode's kind only", () => {
    expect(listView(shown, "kiting", CATALOG, true)).toMatchObject({ total: 3, hiddenCount: 1 });
    expect(listView(shown, "flying", CATALOG, true)).toMatchObject({ total: 2, hiddenCount: 1 });
    expect(listView([], "kiting", CATALOG, true)).toEqual({ shown: [], total: 3, hiddenCount: 3 });
  });
  it("hides nothing without a start", () => {
    expect(listView(shown, "kiting", CATALOG, false)).toMatchObject({ total: 3, hiddenCount: 0 });
    expect(listView([], "flying", CATALOG, false)).toEqual({ shown: [], total: 2, hiddenCount: 0 });
  });
});
