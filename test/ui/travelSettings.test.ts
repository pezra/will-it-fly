import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultTravelSettings,
  loadTravelSettings,
  maxSeconds,
  saveTravelSettings,
  type TravelSettings,
} from "../../src/ui/travelSettings";
import { mapStore } from "../support/builders";

const KEY = "willItFly.travel.v1";

afterEach(() => vi.restoreAllMocks());

const PLACE: TravelSettings = {
  start: { kind: "place", name: "Golden, CO", coordinate: { latitude: 39.7555, longitude: -105.2211 } },
  maxHours: 3,
};

describe("loadTravelSettings and saveTravelSettings", () => {
  it("round-trips geolocation with each radius", () => {
    for (const maxHours of [1, 2, 3, 4, "any"] as const) {
      const store = mapStore();
      const settings: TravelSettings = { start: { kind: "geolocation" }, maxHours };
      saveTravelSettings(store, settings);
      expect(loadTravelSettings(store)).toEqual(settings);
    }
  });

  it("round-trips a place", () => {
    const store = mapStore();
    saveTravelSettings(store, PLACE);
    expect(loadTravelSettings(store)).toEqual(PLACE);
  });

  it("writes under the literal versioned key", () => {
    const map = new Map<string, string>();
    saveTravelSettings(mapStore(map), PLACE);
    expect(JSON.parse(map.get("willItFly.travel.v1") ?? "null")).toEqual(PLACE);
  });

  it("returns the defaults when nothing is stored", () => {
    expect(loadTravelSettings(mapStore())).toEqual(defaultTravelSettings());
  });

  it.each([
    ["non-JSON", "{not json"],
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "42"],
    ["an unknown start kind", JSON.stringify({ start: { kind: "gps" }, maxHours: 2 })],
    ["a start kind that is not a string", JSON.stringify({ start: { kind: 1 }, maxHours: 2 })],
    [
      "a latitude just past 90",
      JSON.stringify({ ...PLACE, start: { ...PLACE.start, coordinate: { latitude: 90.0001, longitude: 0 } } }),
    ],
    [
      "a longitude just past -180",
      JSON.stringify({ ...PLACE, start: { ...PLACE.start, coordinate: { latitude: 0, longitude: -180.0001 } } }),
    ],
    [
      "a latitude as a string",
      JSON.stringify({ ...PLACE, start: { ...PLACE.start, coordinate: { latitude: "39.7", longitude: -105 } } }),
    ],
    [
      "a non-finite longitude",
      JSON.stringify({ ...PLACE, start: { ...PLACE.start, coordinate: { latitude: 39.7, longitude: null } } }),
    ],
    ["an empty place name", JSON.stringify({ ...PLACE, start: { ...PLACE.start, name: "" } })],
    [
      "a 121-character place name",
      JSON.stringify({ ...PLACE, start: { ...PLACE.start, name: "x".repeat(121) } }),
    ],
    ["an unknown maxHours of 5", JSON.stringify({ ...PLACE, maxHours: 5 })],
    ["a maxHours of 0", JSON.stringify({ ...PLACE, maxHours: 0 })],
    ["a maxHours string of \"2\"", JSON.stringify({ ...PLACE, maxHours: "2" })],
    ["a maxHours of 2.5", JSON.stringify({ ...PLACE, maxHours: 2.5 })],
    ["a missing maxHours", JSON.stringify({ start: PLACE.start })],
    [
      "a valid maxHours next to a bad start",
      JSON.stringify({ start: { kind: "place", name: "", coordinate: { latitude: 39.7555, longitude: -105.2211 } }, maxHours: 4 }),
    ],
  ])("returns the defaults for %s", (_label, stored) => {
    const store = mapStore(new Map([[KEY, stored]]));
    expect(loadTravelSettings(store)).toEqual(defaultTravelSettings());
  });

  it("accepts coordinates on the range limits and a 120-character name", () => {
    const edges: TravelSettings[] = [
      { start: { kind: "place", name: "x".repeat(120), coordinate: { latitude: 90, longitude: 180 } }, maxHours: "any" },
      { start: { kind: "place", name: "y", coordinate: { latitude: -90, longitude: -180 } }, maxHours: 1 },
    ];
    for (const settings of edges) {
      expect(loadTravelSettings(mapStore(new Map([[KEY, JSON.stringify(settings)]])))).toEqual(settings);
    }
  });

  it("drops stray stored fields", () => {
    const stored = { start: { kind: "geolocation", extra: 1 }, maxHours: 2, extra: true };
    const loaded = loadTravelSettings(mapStore(new Map([[KEY, JSON.stringify(stored)]])));
    expect(loaded).toEqual({ start: { kind: "geolocation" }, maxHours: 2 });
  });

  it("returns a fresh copy each time", () => {
    const first = loadTravelSettings(mapStore());
    const second = loadTravelSettings(mapStore());
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.start).not.toBe(second.start);
  });

  it("returns the defaults when reading the store throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => {},
    };
    expect(loadTravelSettings(store)).toEqual(defaultTravelSettings());
  });

  it("does not throw when writing the store throws, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      get: () => undefined,
      set: () => {
        throw new Error("full");
      },
    };
    expect(() => saveTravelSettings(store, PLACE)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe("maxSeconds", () => {
  it("converts hours to seconds", () => {
    expect(maxSeconds({ start: { kind: "geolocation" }, maxHours: 1 })).toBe(3600);
    expect(maxSeconds({ start: { kind: "geolocation" }, maxHours: 4 })).toBe(14400);
  });

  it("is undefined for any distance", () => {
    expect(maxSeconds({ start: { kind: "geolocation" }, maxHours: "any" })).toBeUndefined();
  });
});
