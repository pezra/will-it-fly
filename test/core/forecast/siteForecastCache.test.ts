import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSiteForecastCache,
  dayKey,
  mainKey,
  MAX_CACHED_SITES,
  SITE_CACHE_KEY,
} from "../../../src/core/forecast/siteForecastCache";
import type { SiteForecastSave } from "../../../src/core/forecast/siteForecastCache";
import type { RemovableStore } from "../../../src/core/keyValueStore";
import type { Launch } from "../../../src/core/sites/site";
import { mapStore, testLaunch } from "../../support/builders";

const HOUR_MS = 3_600_000;

function launch(id: string, latitude: number, longitude: number, elevationFt = 7000): Launch {
  return testLaunch({ id, name: id, coordinate: { latitude, longitude }, elevationFt });
}

const launches = [launch("a/1", 39.5, -107.3), launch("a/2", 38.9, -106.9)];

/** The cache never parses the slices, so any string stands in for them. */
function save(key: string, fetchedAt = 1_000, own: readonly Launch[] = launches): SiteForecastSave {
  return { key, launches: own, fetchedAt, launchRaw: `L ${key}`, neighborRaw: `N ${key}` };
}

/** A map store that counts `set` calls. */
function countingStore(map = new Map<string, string>()): RemovableStore & { sets: number } {
  const inner = mapStore(map);
  const store = {
    sets: 0,
    get: inner.get,
    remove: inner.remove,
    set(k: string, v: string) {
      store.sets++;
      inner.set(k, v);
    },
  };
  return store;
}

function storedKeys(map: Map<string, string>): string[] {
  const text = map.get(SITE_CACHE_KEY);
  return text === undefined ? [] : Object.keys(JSON.parse(text) as object).sort();
}

/** Saves `keys` one commit each, a minute apart, so the first is the least recently used. */
function fill(map: Map<string, string>, keys: readonly string[]): void {
  const cache = createSiteForecastCache(mapStore(map));
  keys.forEach((key, i) => cache.open().commit({ saves: [save(key)], used: [], now: i * 60_000 }));
}

afterEach(() => vi.restoreAllMocks());

describe("SiteForecastCache", () => {
  it("keysNameTheSiteAndDay", () => {
    expect(mainKey("rmhpa/x")).toBe("main:rmhpa/x");
    expect(dayKey("2026-11-12", "rmhpa/x")).toBe("day:2026-11-12:rmhpa/x");
  });

  it("aSavedEntryIsAHitInTheNextSnapshot", () => {
    const map = new Map<string, string>();
    const cache = createSiteForecastCache(mapStore(map));
    cache.open().commit({ saves: [save("main:a")], used: [], now: 5_000 });
    expect([...map.keys()]).toEqual([SITE_CACHE_KEY]);
    expect(cache.open().get("main:a", launches)).toEqual({
      fetchedAt: 1_000,
      launchRaw: "L main:a",
      neighborRaw: "N main:a",
    });
  });

  it("anUnknownKeyIsAMiss", () => {
    const cache = createSiteForecastCache(mapStore());
    expect(cache.open().get("main:a", launches)).toBeUndefined();
    cache.open().commit({ saves: [save("main:a")], used: [], now: 0 });
    expect(cache.open().get("main:b", launches)).toBeUndefined();
    expect(cache.open().get(dayKey("2026-11-12", "a"), launches)).toBeUndefined();
  });

  it.each([
    ["a different id", [launch("a/1", 39.5, -107.3), launch("a/3", 38.9, -106.9)]],
    ["a different coordinate", [launch("a/1", 39.5, -107.3), launch("a/2", 38.9, -106.8)]],
    ["a different elevation", [launch("a/1", 39.5, -107.3), launch("a/2", 38.9, -106.9, 7001)]],
    ["a different order", [launch("a/2", 38.9, -106.9), launch("a/1", 39.5, -107.3)]],
    ["a missing launch", [launch("a/1", 39.5, -107.3)]],
  ])("aChangedLaunchListIsAMiss: %s", (_name, other) => {
    const cache = createSiteForecastCache(mapStore());
    cache.open().commit({ saves: [save("main:a")], used: [], now: 0 });
    expect(cache.open().get("main:a", other)).toBeUndefined();
  });

  it.each(["not json {", "42", "[]", "null", '"text"'])("aCorruptBlobReadsAsEmpty: %s", (text) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const map = new Map([[SITE_CACHE_KEY, text]]);
    const cache = createSiteForecastCache(mapStore(map));
    const snapshot = cache.open();
    expect(snapshot.get("main:a", launches)).toBeUndefined();
    snapshot.commit({ saves: [save("main:a")], used: [], now: 0 });
    expect(storedKeys(map)).toEqual(["main:a"]);
  });

  it.each([
    ["not an object", 5],
    ["no usedAt", { fetchedAt: 1, launchesKey: "k", launchRaw: "l", neighborRaw: "n" }],
    ["a string fetchedAt", { fetchedAt: "1", usedAt: 1, launchesKey: "k", launchRaw: "l", neighborRaw: "n" }],
    ["no launchRaw", { fetchedAt: 1, usedAt: 1, launchesKey: "k", neighborRaw: "n" }],
    ["an array neighborRaw", { fetchedAt: 1, usedAt: 1, launchesKey: "k", launchRaw: "l", neighborRaw: [] }],
  ])("anEntryOfTheWrongShapeIsAMissAndOthersSurvive: %s", (_name, bad) => {
    const map = new Map<string, string>();
    const cache = createSiteForecastCache(mapStore(map));
    cache.open().commit({ saves: [save("main:good")], used: [], now: 0 });
    const blob = JSON.parse(map.get(SITE_CACHE_KEY)!) as Record<string, unknown>;
    map.set(SITE_CACHE_KEY, JSON.stringify({ ...blob, "main:bad": bad }));

    const snapshot = cache.open();
    expect(snapshot.get("main:bad", launches)).toBeUndefined();
    expect(snapshot.get("main:good", launches)).toBeDefined();
    // The bad entry is dropped at the next write; it never breaks eviction.
    snapshot.commit({ saves: [save("main:new")], used: [], now: 1 });
    expect(storedKeys(map)).toEqual(["main:good", "main:new"]);
  });

  it("aStoreWhoseGetThrowsReadsAsEmpty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store: RemovableStore = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => undefined,
      remove: () => undefined,
    };
    expect(createSiteForecastCache(store).open().get("main:a", launches)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("aCommitWritesOnce", () => {
    const store = countingStore();
    const cache = createSiteForecastCache(store);
    cache.open().commit({ saves: [save("main:a")], used: [], now: 0 });
    const sets = store.sets;
    const snapshot = cache.open();
    snapshot.get("main:a", launches);
    snapshot.commit({
      saves: [save("main:b"), save("main:c"), save(dayKey("2026-11-12", "d"))],
      used: ["main:a"],
      now: 2 * HOUR_MS,
    });
    expect(store.sets - sets).toBe(1);
  });

  it("aNoOpCommitMakesNoWrite", () => {
    const store = countingStore();
    const cache = createSiteForecastCache(store);
    cache.open().commit({ saves: [save("main:a")], used: [], now: 0 });
    const sets = store.sets;

    cache.open().commit({ saves: [], used: [], now: 10 * HOUR_MS });
    cache.open().commit({ saves: [], used: ["main:a"], now: HOUR_MS });
    cache.open().commit({ saves: [], used: ["main:missing"], now: 10 * HOUR_MS });
    expect(store.sets).toBe(sets);
  });

  it("aUseOverAnHourAfterTheLastWritesUsedAt", () => {
    const map = new Map<string, string>();
    const store = countingStore(map);
    const cache = createSiteForecastCache(store);
    cache.open().commit({ saves: [save("main:a")], used: [], now: 0 });
    const sets = store.sets;

    cache.open().commit({ saves: [], used: ["main:a"], now: HOUR_MS + 1 });
    expect(store.sets).toBe(sets + 1);
    const entry = (JSON.parse(map.get(SITE_CACHE_KEY)!) as Record<string, { usedAt: number }>)["main:a"];
    expect(entry?.usedAt).toBe(HOUR_MS + 1);
  });

  it("aSaveLeavesOtherSitesEntriesUntouched", () => {
    const map = new Map<string, string>();
    const cache = createSiteForecastCache(mapStore(map));
    cache.open().commit({ saves: [save("main:a", 1_000), save("main:b", 2_000)], used: [], now: 0 });
    const before = JSON.parse(map.get(SITE_CACHE_KEY)!) as Record<string, unknown>;

    cache.open().commit({ saves: [save("main:a", 9_000)], used: [], now: 60_000 });
    const after = JSON.parse(map.get(SITE_CACHE_KEY)!) as Record<string, unknown>;
    expect(after["main:b"]).toEqual(before["main:b"]);
    expect(cache.open().get("main:a", launches)?.fetchedAt).toBe(9_000);
  });

  it("theLeastRecentlyUsedGoFirstAtTheCap", () => {
    const map = new Map<string, string>();
    const keys = Array.from({ length: MAX_CACHED_SITES }, (_, i) => mainKey(`s${i}`));
    fill(map, keys);
    expect(storedKeys(map)).toHaveLength(MAX_CACHED_SITES);

    // Using s0 makes s1 the least recently used.
    const cache = createSiteForecastCache(mapStore(map));
    cache.open().commit({ saves: [save(mainKey("new"))], used: [mainKey("s0")], now: 100 * HOUR_MS });
    const stored = storedKeys(map);
    expect(stored).toHaveLength(MAX_CACHED_SITES);
    expect(stored).toContain(mainKey("s0"));
    expect(stored).toContain(mainKey("new"));
    expect(stored).not.toContain(mainKey("s1"));
  });

  it("dayEntriesAreEvictedBeforeMainEntries", () => {
    const map = new Map<string, string>();
    const mains = Array.from({ length: MAX_CACHED_SITES - 2 }, (_, i) => mainKey(`s${i}`));
    // The day entries are the most recently used, yet still go first.
    fill(map, [...mains, dayKey("2026-11-12", "d0"), dayKey("2026-11-13", "d1")]);

    const cache = createSiteForecastCache(mapStore(map));
    cache.open().commit({ saves: [save(mainKey("x")), save(mainKey("y"))], used: [], now: 100 * HOUR_MS });
    const stored = storedKeys(map);
    expect(stored).toHaveLength(MAX_CACHED_SITES);
    expect(stored.filter((k) => k.startsWith("day:"))).toEqual([]);
    expect(stored).toEqual([...mains, mainKey("x"), mainKey("y")].sort());
  });

  it("moreEntriesThanTheCapInOneCommitKeepsAllOfThem", () => {
    const map = new Map<string, string>();
    fill(map, [mainKey("old"), mainKey("used")]);
    const many = Array.from({ length: MAX_CACHED_SITES + 5 }, (_, i) => save(dayKey("2026-11-12", `s${i}`)));

    const cache = createSiteForecastCache(mapStore(map));
    cache.open().commit({ saves: many, used: [mainKey("used")], now: 100 * HOUR_MS });
    const stored = storedKeys(map);
    expect(stored).toHaveLength(MAX_CACHED_SITES + 6);
    expect(stored).toContain(mainKey("used"));
    expect(stored).not.toContain(mainKey("old"));
  });

  it("aKeyBothSavedAndUsedCountsOnceAgainstTheCap", () => {
    const map = new Map<string, string>();
    const keys = Array.from({ length: MAX_CACHED_SITES }, (_, i) => mainKey(`s${i}`));
    fill(map, keys);

    const cache = createSiteForecastCache(mapStore(map));
    cache.open().commit({ saves: [save(mainKey("s0"))], used: [mainKey("s0")], now: 100 * HOUR_MS });
    expect(storedKeys(map)).toHaveLength(MAX_CACHED_SITES);
  });

  it("aQuotaFailureDropsTheOlderHalfAndRetriesOnce", () => {
    const map = new Map<string, string>();
    fill(map, ["main:e0", "main:e1", "main:e2", "main:e3", "main:kept"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inner = mapStore(map);
    let calls = 0;
    const store: RemovableStore = {
      ...inner,
      set(k, v) {
        calls++;
        if (calls === 1) throw new Error("QuotaExceededError");
        inner.set(k, v);
      },
    };

    const cache = createSiteForecastCache(store);
    cache.open().commit({ saves: [save("main:new")], used: ["main:kept"], now: 100 * HOUR_MS });
    expect(calls).toBe(2);
    expect(storedKeys(map)).toEqual(["main:e2", "main:e3", "main:kept", "main:new"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("aSecondFailureIsLoggedAndIgnored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const store: RemovableStore = {
      get: () => undefined,
      set: () => {
        calls++;
        throw new Error("QuotaExceededError");
      },
      remove: () => undefined,
    };
    const cache = createSiteForecastCache(store);
    expect(() =>
      cache.open().commit({ saves: [save("main:a")], used: [], now: 0 }),
    ).not.toThrow();
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("constructingTheCacheRemovesTheLegacyKeys", () => {
    const map = new Map([
      ["will-it-fly/forecast-v1", "old"],
      ["will-it-fly/forecast-v1/day", "old day"],
      ["willItFly.travel.v1", "settings"],
    ]);
    createSiteForecastCache(mapStore(map));
    expect([...map.keys()]).toEqual(["willItFly.travel.v1"]);
  });

  it("aStoreWhoseRemoveThrowsStillGivesACache", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store: RemovableStore = {
      ...mapStore(),
      remove: () => {
        throw new Error("blocked");
      },
    };
    const cache = createSiteForecastCache(store);
    cache.open().commit({ saves: [save("main:a")], used: [], now: 0 });
    expect(cache.open().get("main:a", launches)).toBeDefined();
  });
});
