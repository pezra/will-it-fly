import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RADIUS_CHOICES,
  defaultTravelSettings,
  loadTravelSettings,
  maxSeconds,
  radiusLabel,
  radiusMinutes,
  saveTravelSettings,
  withRadius,
  type TravelSettings,
} from "../../src/ui/travelSettings";
import { mapStore } from "../support/builders";

const KEY = "willItFly.travel.v1";

afterEach(() => vi.restoreAllMocks());

const PLACE: TravelSettings = {
  start: { kind: "place", name: "Golden, CO", coordinate: { latitude: 39.7555, longitude: -105.2211 } },
  maxHours: 3,
  kiteMinutes: 30,
};

describe("loadTravelSettings and saveTravelSettings", () => {
  it("round-trips geolocation with each radius", () => {
    for (const maxHours of [1, 2, 3, 4] as const) {
      const store = mapStore();
      const settings: TravelSettings = { start: { kind: "geolocation" }, maxHours, kiteMinutes: 30 };
      saveTravelSettings(store, settings);
      expect(loadTravelSettings(store)).toEqual(settings);
    }
  });

  it("round-trips each kite radius", () => {
    for (const kiteMinutes of [15, 30, 60] as const) {
      const store = mapStore();
      const settings: TravelSettings = { ...PLACE, kiteMinutes };
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

  it("reads a stored \"any\" as the default radius and keeps the start", () => {
    const stored = { start: PLACE.start, maxHours: "any" };
    const store = mapStore(new Map([[KEY, JSON.stringify(stored)]]));
    expect(loadTravelSettings(store)).toEqual({ start: PLACE.start, maxHours: 2, kiteMinutes: 30 });
  });

  it("reads settings stored before the kite radius with a 30 min kite radius, keeping the rest", () => {
    const stored = { start: PLACE.start, maxHours: 4 };
    const store = mapStore(new Map([[KEY, JSON.stringify(stored)]]));
    expect(loadTravelSettings(store)).toEqual({ start: PLACE.start, maxHours: 4, kiteMinutes: 30 });
  });

  it.each([
    ["45", 45],
    ["0", 0],
    ["a string of \"15\"", "15"],
    ["null", null],
    ["a fraction", 15.5],
    ["an object", {}],
  ])("reads a kite radius of %s as 30 min, keeping the start and flying radius", (_label, kiteMinutes) => {
    const stored = { start: PLACE.start, maxHours: 4, kiteMinutes };
    const store = mapStore(new Map([[KEY, JSON.stringify(stored)]]));
    expect(loadTravelSettings(store)).toEqual({ start: PLACE.start, maxHours: 4, kiteMinutes: 30 });
  });

  it("still resets everything for a bad start, whatever the kite radius", () => {
    const stored = { start: { kind: "gps" }, maxHours: 4, kiteMinutes: 15 };
    const store = mapStore(new Map([[KEY, JSON.stringify(stored)]]));
    expect(loadTravelSettings(store)).toEqual(defaultTravelSettings());
  });

  it("returns the defaults for a radius that was never offered", () => {
    const stored = { start: PLACE.start, maxHours: 5 };
    const store = mapStore(new Map([[KEY, JSON.stringify(stored)]]));
    expect(loadTravelSettings(store)).toEqual(defaultTravelSettings());
  });

  it("accepts coordinates on the range limits and a 120-character name", () => {
    const edges: TravelSettings[] = [
      { start: { kind: "place", name: "x".repeat(120), coordinate: { latitude: 90, longitude: 180 } }, maxHours: 4, kiteMinutes: 60 },
      { start: { kind: "place", name: "y", coordinate: { latitude: -90, longitude: -180 } }, maxHours: 1, kiteMinutes: 15 },
    ];
    for (const settings of edges) {
      expect(loadTravelSettings(mapStore(new Map([[KEY, JSON.stringify(settings)]])))).toEqual(settings);
    }
  });

  it("drops stray stored fields", () => {
    const stored = { start: { kind: "geolocation", extra: 1 }, maxHours: 2, kiteMinutes: 15, extra: true };
    const loaded = loadTravelSettings(mapStore(new Map([[KEY, JSON.stringify(stored)]])));
    expect(loaded).toEqual({ start: { kind: "geolocation" }, maxHours: 2, kiteMinutes: 15 });
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

describe("defaultTravelSettings", () => {
  it("starts from the location with 2 h to fly and 30 min to kite", () => {
    expect(defaultTravelSettings()).toEqual({ start: { kind: "geolocation" }, maxHours: 2, kiteMinutes: 30 });
  });
});

describe("RADIUS_CHOICES", () => {
  it("lists each mode's choices in minutes", () => {
    expect(RADIUS_CHOICES.flying).toEqual([60, 120, 180, 240]);
    expect(RADIUS_CHOICES.kiting).toEqual([15, 30, 60]);
  });
});

describe("radiusMinutes", () => {
  it("reads the mode's own radius", () => {
    const settings: TravelSettings = { start: { kind: "geolocation" }, maxHours: 3, kiteMinutes: 15 };
    expect(radiusMinutes(settings, "flying")).toBe(180);
    expect(radiusMinutes(settings, "kiting")).toBe(15);
  });
});

describe("withRadius", () => {
  const settings: TravelSettings = { ...PLACE, maxHours: 2, kiteMinutes: 30 };
  it("sets the flying radius from minutes and leaves the kite radius and start alone", () => {
    expect(withRadius(settings, "flying", 240)).toEqual({ ...settings, maxHours: 4 });
    expect(withRadius(settings, "flying", 60)).toEqual({ ...settings, maxHours: 1 });
  });
  it("sets the kite radius and leaves the flying radius and start alone", () => {
    expect(withRadius(settings, "kiting", 15)).toEqual({ ...settings, kiteMinutes: 15 });
    expect(withRadius(settings, "kiting", 60)).toEqual({ ...settings, kiteMinutes: 60 });
  });
  it("does not change the settings it is given", () => {
    withRadius(settings, "kiting", 15);
    expect(settings).toEqual({ ...PLACE, maxHours: 2, kiteMinutes: 30 });
  });
  it("ignores a value that is not one of the mode's choices", () => {
    expect(withRadius(settings, "flying", 15)).toEqual(settings);
    expect(withRadius(settings, "flying", 90)).toEqual(settings);
    expect(withRadius(settings, "kiting", 120)).toEqual(settings);
    expect(withRadius(settings, "kiting", 45)).toEqual(settings);
    expect(withRadius(settings, "kiting", Number.NaN)).toEqual(settings);
  });
  it("accepts every choice for its mode", () => {
    for (const mode of ["flying", "kiting"] as const) {
      for (const minutes of RADIUS_CHOICES[mode]) {
        expect(radiusMinutes(withRadius(settings, mode, minutes), mode)).toBe(minutes);
      }
    }
  });
});

describe("maxSeconds", () => {
  it("converts the flying hours to seconds", () => {
    expect(maxSeconds({ start: { kind: "geolocation" }, maxHours: 1, kiteMinutes: 30 }, "flying")).toBe(3600);
    expect(maxSeconds({ start: { kind: "geolocation" }, maxHours: 4, kiteMinutes: 30 }, "flying")).toBe(14400);
  });
  it("converts the kite minutes to seconds", () => {
    const base: TravelSettings = { start: { kind: "geolocation" }, maxHours: 4, kiteMinutes: 15 };
    expect(maxSeconds(base, "kiting")).toBe(900);
    expect(maxSeconds({ ...base, kiteMinutes: 30 }, "kiting")).toBe(1800);
    expect(maxSeconds({ ...base, kiteMinutes: 60 }, "kiting")).toBe(3600);
  });
});

describe("radiusLabel", () => {
  it("reads whole hours as hours and the rest as minutes", () => {
    expect(radiusLabel(15)).toBe("15 min");
    expect(radiusLabel(30)).toBe("30 min");
    expect(radiusLabel(60)).toBe("1 h");
    expect(radiusLabel(120)).toBe("2 h");
    expect(radiusLabel(240)).toBe("4 h");
    expect(radiusLabel(90)).toBe("90 min");
  });
});
