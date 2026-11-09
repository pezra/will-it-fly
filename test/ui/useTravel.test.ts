import { describe, expect, it } from "vitest";
import { startKey } from "../../src/core/travel/driveTime";
import type { TravelSettings } from "../../src/ui/travelSettings";
import { placeStart, resolveStart } from "../../src/ui/useTravel";

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
