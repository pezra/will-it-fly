import { afterEach, describe, expect, it, vi } from "vitest";
import { createForecastCache } from "../../../src/core/forecast/forecastCache";
import type { KeyValueStore } from "../../../src/core/forecast/forecastCache";
import type { Launch } from "../../../src/core/sites/site";

function launch(id: string, latitude: number, longitude: number, elevationFt = 7000): Launch {
  return {
    id,
    name: id,
    coordinate: { latitude, longitude },
    elevationFt,
    directions: { ok: [], ideal: [] },
  };
}

const launches = [launch("a", 39.5, -107.3), launch("b", 38.9, -106.9)];
const entry = { launchRaw: "[1]", neighborRaw: "[2]", fetchedAt: 1_000, launches };

function mapStore(map = new Map<string, string>()): KeyValueStore {
  return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v) };
}

afterEach(() => vi.restoreAllMocks());

describe("ForecastCache", () => {
  it("roundTripsThroughAMapStore", () => {
    const map = new Map<string, string>();
    const cache = createForecastCache(mapStore(map));
    cache.save(entry);
    expect([...map.keys()]).toEqual(["flyable-sites/forecast-v1"]);
    expect(cache.load(launches)).toEqual({ launchRaw: "[1]", neighborRaw: "[2]", fetchedAt: 1_000 });
  });

  it("usesTheGivenKey", () => {
    const map = new Map<string, string>();
    createForecastCache(mapStore(map), "other/key").save(entry);
    expect([...map.keys()]).toEqual(["other/key"]);
  });

  it("emptyStoreLoadsUndefined", () => {
    expect(createForecastCache(mapStore()).load(launches)).toBeUndefined();
  });

  it.each([
    ["a different id", [launch("a", 39.5, -107.3), launch("c", 38.9, -106.9)]],
    ["a different coordinate", [launch("a", 39.5, -107.3), launch("b", 38.9, -106.8)]],
    ["a different elevation", [launch("a", 39.5, -107.3), launch("b", 38.9, -106.9, 7001)]],
    ["a different order", [launch("b", 38.9, -106.9), launch("a", 39.5, -107.3)]],
    ["an extra launch", [...launches, launch("c", 40, -105)]],
    ["a missing launch", [launch("a", 39.5, -107.3)]],
  ])("launchListMismatchGivesUndefined: %s", (_name, other) => {
    const cache = createForecastCache(mapStore());
    cache.save(entry);
    expect(cache.load(other)).toBeUndefined();
  });

  it.each(["not json {", "42", "[]", '{"launchRaw":"x"}', '{"launchRaw":"x","neighborRaw":"y","fetchedAt":1,"launches":[{"id":1}]}'])(
    "corruptContentsGiveUndefined: %s",
    (text) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const cache = createForecastCache(mapStore(new Map([["flyable-sites/forecast-v1", text]])));
      expect(cache.load(launches)).toBeUndefined();
    },
  );

  it("aStoreWhoseGetThrowsLoadsUndefined", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store: KeyValueStore = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => undefined,
    };
    expect(createForecastCache(store).load(launches)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("aStoreWhoseSetThrowsIsLoggedAndSwallowed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store: KeyValueStore = {
      get: () => undefined,
      set: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => createForecastCache(store).save(entry)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});
