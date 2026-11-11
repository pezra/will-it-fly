import { describe, expect, it } from "vitest";
import { bundledSiteProvider } from "../../src/core/sites/siteProvider";
import { startKey, withinReach } from "../../src/core/travel/driveTime";
import type { TravelSettings } from "../../src/ui/travelSettings";
import { EXAMPLE_PLACE, offersExample, placeStart, resolveStart } from "../../src/ui/useTravel";

const boulder = { latitude: 40.015, longitude: -105.27 };
const aspen = { latitude: 39.19, longitude: -106.82 };

const geolocation: TravelSettings = { start: { kind: "geolocation" }, maxHours: 2 };
const place: TravelSettings = {
  start: { kind: "place", name: "Aspen", coordinate: aspen },
  maxHours: 2,
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

describe("EXAMPLE_PLACE", () => {
  it("is stored as Boulder", () => {
    expect(placeStart(EXAMPLE_PLACE)).toEqual({
      kind: "place",
      name: "Boulder",
      coordinate: EXAMPLE_PLACE.coordinate,
    });
  });
  it("has a catalog site with a launch within an hour's straight-line reach", async () => {
    const sites = (await bundledSiteProvider().sites()).filter((s) => s.launches.length > 0);
    expect(withinReach(sites, EXAMPLE_PLACE.coordinate, 1).length).toBeGreaterThan(0);
  });
});

describe("offersExample", () => {
  it("offers the example with no start", () => {
    expect(offersExample({ stage: "needsStart", missing: 0, shownCount: 0 })).toBe(true);
  });
  it("offers the example when routing is done and nothing is in range", () => {
    expect(offersExample({ stage: "ready", missing: 0, shownCount: 0 })).toBe(true);
  });
  it("waits while locating or routing", () => {
    expect(offersExample({ stage: "locating", missing: 0, shownCount: 0 })).toBe(false);
    expect(offersExample({ stage: "routing", missing: 0, shownCount: 0 })).toBe(false);
  });
  it("doesn't offer it while in-range sites are still loading", () => {
    expect(offersExample({ stage: "ready", missing: 2, shownCount: 0 })).toBe(false);
  });
  it("doesn't offer it when sites are shown", () => {
    expect(offersExample({ stage: "ready", missing: 0, shownCount: 3 })).toBe(false);
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
