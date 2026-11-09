import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "../../../src/core/keyValueStore";
import type { Transport } from "../../../src/core/forecast/openMeteoClient";
import { distanceM } from "../../../src/core/sites/coordinate";
import type { Coordinate } from "../../../src/core/sites/site";
import {
  DRIVE_TIME_CACHE_KEY,
  DriveTimeError,
  driveTimesFor,
  estimateDriveSeconds,
  fetchDriveTimes,
  MAX_ROAD_MPH,
  roundStart,
  startKey,
  withinReach,
} from "../../../src/core/travel/driveTime";
import { METERS_PER_MILE } from "../../../src/core/units";
import { mapStore, testLaunch, testSite } from "../../support/builders";
import tableJSON from "../../fixtures/osrm-table.json?raw";
import tableURL from "../../fixtures/osrm-table.url.txt?raw";

afterEach(() => vi.restoreAllMocks());

function coord(latitude: number, longitude: number): Coordinate {
  return { latitude, longitude };
}

/** Rounds to 40.01,-105.27, the start in the recording. */
const BOULDER = coord(40.0123, -105.2705);

/** The first launch of each site in the recording, in its order. */
const RECORDED_DESTINATIONS: Coordinate[] = [
  coord(40.0562, -105.3),
  coord(39.7001, -106.6335),
  coord(39.4734, -106.1574),
  coord(39.5428, -107.3003),
  coord(38.8897, -106.9455),
  coord(39.7461, -105.2407),
  coord(39.66, -106.6576),
  coord(39.4957, -106.112),
  coord(39.5331, -107.3417),
  coord(38.9489, -104.8863),
  coord(39.9189, -106.2861),
  coord(39.4144, -105.773),
  coord(39.5543, -106.1152),
  coord(39.3933, -108.7727),
  coord(38.2916, -105.8822),
  coord(39.5859, -106.041),
  coord(39.0814, -104.9259),
  coord(39.5989, -108.7963),
  coord(39.2777, -108.9943),
  coord(39.1642, -106.8273),
  coord(39.6675, -105.8647),
];

function respond(body: string, status = 200): Transport {
  return async () => ({ status, body });
}

function okBody(durations: unknown[]): string {
  return JSON.stringify({ code: "Ok", durations: [durations] });
}

/** The `lon,lat` pairs in an OSRM table URL's path, start first. */
function pathCoordinates(url: string): string[] {
  const path = url.slice(0, url.indexOf("?"));
  return path.slice(path.lastIndexOf("/") + 1).split(";");
}

function queryParam(url: string, name: string): string | undefined {
  return new URL(url).searchParams.get(name) ?? undefined;
}

async function rejection(promise: Promise<unknown>): Promise<DriveTimeError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(DriveTimeError);
    return e as DriveTimeError;
  }
  throw new Error("expected fetchDriveTimes to reject");
}

describe("estimateDriveSeconds", () => {
  it("boulderToGoldenAtFortyMph", () => {
    // 30.0 km straight-line = 18.64 mi; at 40 mph that is 0.466 h.
    const seconds = estimateDriveSeconds(coord(40.015, -105.27), coord(39.7461, -105.2407));
    expect(seconds).toBeCloseTo(1678, 0);
  });

  it("isZeroForTheSamePoint", () => {
    expect(estimateDriveSeconds(BOULDER, BOULDER)).toBe(0);
  });
});

describe("withinReach", () => {
  const siteAt = (id: string, c: Coordinate) =>
    testSite({ id, launches: [testLaunch({ id: `${id}/main`, coordinate: c })] });
  const ids = (sites: readonly { id: string }[]) => sites.map((s) => s.id);
  // About 30 km (18.6 mi) from BOULDER, and about 280 km (174 mi) from it.
  const NEAR = coord(39.7461, -105.2407);
  const FAR = coord(37.5, -105.2407);

  it("keepsSitesInsideAndDropsSitesOutside", () => {
    const sites = [siteAt("near", NEAR), siteAt("far", FAR)];
    expect(ids(withinReach(sites, BOULDER, 2))).toEqual(["near"]);
  });

  it("widensWithTheHours", () => {
    const sites = [siteAt("far", FAR)];
    expect(withinReach(sites, BOULDER, 1)).toEqual([]);
    expect(ids(withinReach(sites, BOULDER, 4))).toEqual(["far"]);
  });

  it("keepsASiteExactlyAtTheBoundAndDropsOneJustOver", () => {
    const site = siteAt("edge", NEAR);
    const miles = distanceM(BOULDER, NEAR) / METERS_PER_MILE;
    const hours = miles / MAX_ROAD_MPH;
    expect(MAX_ROAD_MPH * hours).toBe(miles);
    expect(ids(withinReach([site], BOULDER, hours))).toEqual(["edge"]);
    expect(withinReach([site], BOULDER, hours * (1 - 1e-9))).toEqual([]);
  });

  it("keepsASiteWithoutALaunch", () => {
    const none = testSite({ id: "none", launches: [] });
    expect(ids(withinReach([none], BOULDER, 1))).toEqual(["none"]);
  });

  it("measuresToTheFirstLaunch", () => {
    const site = testSite({
      id: "two",
      launches: [
        testLaunch({ id: "two/a", coordinate: FAR }),
        testLaunch({ id: "two/b", coordinate: NEAR }),
      ],
    });
    expect(withinReach([site], BOULDER, 1)).toEqual([]);
  });
});

describe("roundStart and startKey", () => {
  it("roundToHundredthsOfADegree", () => {
    expect(roundStart(BOULDER)).toEqual(coord(40.01, -105.27));
    expect(startKey(BOULDER)).toBe("40.01,-105.27");
  });

  it("keyIsStableForFloatNoise", () => {
    expect(startKey(coord(40.01 + 1e-12, -105.27 - 1e-12))).toBe("40.01,-105.27");
    expect(startKey(coord(40.0099999, -105.2700001))).toBe("40.01,-105.27");
    expect(startKey(coord(40.0149, -105.2651))).toBe("40.01,-105.27");
    expect(startKey(coord(40.0151, -105.2649))).toBe("40.02,-105.26");
  });

  it("keyHasNoNegativeZero", () => {
    expect(startKey(coord(-0.001, -0.001))).toBe("0.00,0.00");
  });
});

describe("fetchDriveTimes", () => {
  it("buildsTheRecordedURL", async () => {
    const urls: string[] = [];
    const transport: Transport = async (url) => {
      urls.push(url);
      return { status: 200, body: tableJSON };
    };
    await fetchDriveTimes(BOULDER, RECORDED_DESTINATIONS, transport);
    expect(urls).toEqual([tableURL.trim()]);
  });

  it("sendsOnlyTheRoundedStartInLonLatOrder", async () => {
    const urls: string[] = [];
    const transport: Transport = async (url) => {
      urls.push(url);
      return { status: 200, body: okBody([60]) };
    };
    await fetchDriveTimes(coord(40.0149, -105.2651), [coord(39.5, -106)], transport);
    await fetchDriveTimes(coord(40.0051, -105.2749), [coord(39.5, -106)], transport);
    expect(pathCoordinates(urls[0]!)).toEqual(["-105.27,40.01", "-106.0000,39.5000"]);
    expect(urls[1]).toBe(urls[0]);
    expect(queryParam(urls[0]!, "sources")).toBe("0");
    expect(queryParam(urls[0]!, "destinations")).toBe("1");
    expect(queryParam(urls[0]!, "annotations")).toBe("duration");
  });

  it("sendsTheSameRoundingTheKeyUsesOnANegativeTie", async () => {
    // Math.round takes -105.125 to -105.12; toFixed alone would give -105.13.
    const start = coord(40.01, -105.125);
    const urls: string[] = [];
    const transport: Transport = async (url) => {
      urls.push(url);
      return { status: 200, body: okBody([60]) };
    };
    await fetchDriveTimes(start, [coord(39.5, -106)], transport);
    expect(pathCoordinates(urls[0]!)[0]).toBe("-105.12,40.01");
    expect(startKey(start)).toBe("40.01,-105.12");
  });

  it("usesTheGivenBaseURLWithoutATrailingSlash", async () => {
    const urls: string[] = [];
    const transport: Transport = async (url) => {
      urls.push(url);
      return { status: 200, body: okBody([60]) };
    };
    await fetchDriveTimes(BOULDER, [coord(39.5, -106)], transport, "http://localhost:5000/");
    expect(urls[0]).toMatch(/^http:\/\/localhost:5000\/table\/v1\/driving\/-105\.27,40\.01;/);
  });

  it("parsesTheRecordedResponse", async () => {
    const times = await fetchDriveTimes(BOULDER, RECORDED_DESTINATIONS, respond(tableJSON));
    expect(times).toHaveLength(RECORDED_DESTINATIONS.length);
    expect(times[0]).toBe(1000.9);
    expect(times[5]).toBe(2285);
    expect(times[20]).toBe(6107);
    // The spliced-in null (Stovepipe) is unroutable; its neighbors are not.
    expect(times[13]).toBeUndefined();
    expect(times.filter((t) => t === undefined)).toHaveLength(1);
  });

  it("noDestinationsMakesNoRequest", async () => {
    const transport = vi.fn<Transport>(respond(okBody([])));
    expect(await fetchDriveTimes(BOULDER, [], transport)).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("batchesSequentiallyWithTheStartInEachBatch", async () => {
    const destinations = Array.from({ length: 250 }, (_, i) => coord(39 + i / 1000, -106));
    const urls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const transport: Transport = async (url) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      urls.push(url);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      // Each duration is the destination's index in the whole list, read back from its latitude.
      const durations = pathCoordinates(url)
        .slice(1)
        .map((pair) => Math.round((Number(pair.split(",")[1]) - 39) * 1000));
      return { status: 200, body: okBody(durations) };
    };
    const times = await fetchDriveTimes(BOULDER, destinations, transport);
    expect(maxInFlight).toBe(1);
    expect(urls).toHaveLength(3);
    expect(urls.map((u) => pathCoordinates(u)[0])).toEqual(Array(3).fill("-105.27,40.01"));
    expect(urls.map((u) => pathCoordinates(u).length - 1)).toEqual([99, 99, 52]);
    for (const u of urls) {
      const n = pathCoordinates(u).length - 1;
      expect(queryParam(u, "destinations")).toBe(Array.from({ length: n }, (_, i) => i + 1).join(";"));
    }
    expect(times).toEqual(Array.from({ length: 250 }, (_, i) => i));
  });

  it("aFailedBatchFailsTheWholeCall", async () => {
    const destinations = Array.from({ length: 150 }, (_, i) => coord(39 + i / 1000, -106));
    let calls = 0;
    const transport: Transport = async (url) => {
      calls += 1;
      if (calls === 2) return { status: 503, body: "" };
      return { status: 200, body: okBody(pathCoordinates(url).slice(1).map(() => 60)) };
    };
    const err = await rejection(fetchDriveTimes(BOULDER, destinations, transport));
    expect(err.kind).toBe("http");
    expect(err.status).toBe(503);
  });

  it.each([
    ["one extra entry", okBody([60, 70, 80])],
    ["one missing entry", okBody([60])],
    ["a negative entry", okBody([60, -1])],
    ["an infinite entry", '{"code":"Ok","durations":[[60,1e999]]}'],
    ["a string entry", okBody([60, "70"])],
    ["no durations", '{"code":"Ok"}'],
    ["durations not an array of arrays", '{"code":"Ok","durations":[60,70]}'],
    ["a body that is an array", "[[60,70]]"],
    ["a body that is not JSON", "<html>busy</html>"],
  ])("rejectsAResponseWith: %s", async (_name, body) => {
    const err = await rejection(
      fetchDriveTimes(BOULDER, [coord(39.5, -106), coord(39.6, -106)], respond(body)),
    );
    expect(err.kind).toBe("unexpectedShape");
    expect(err.detail).not.toBe("");
  });

  it("rejectsANonOkCode", async () => {
    const body = '{"code":"NoRoute","message":"Impossible route between points"}';
    const err = await rejection(fetchDriveTimes(BOULDER, [coord(39.5, -106)], respond(body)));
    expect(err.kind).toBe("api");
    expect(err.message).toContain("NoRoute");
  });

  it("rejectsANon200Status", async () => {
    const err = await rejection(
      fetchDriveTimes(BOULDER, [coord(39.5, -106)], respond(okBody([60]), 429)),
    );
    expect(err.kind).toBe("http");
    expect(err.status).toBe(429);
  });

  it("wrapsATransportFailure", async () => {
    const cause = new Error("network down");
    const transport: Transport = async () => {
      throw cause;
    };
    const err = await rejection(fetchDriveTimes(BOULDER, [coord(39.5, -106)], transport));
    expect(err.kind).toBe("transport");
    expect(err.cause).toBe(cause);
  });
});

describe("driveTimesFor", () => {
  const a = { id: "a", coordinate: coord(39.7461, -105.2407) };
  const b = { id: "b", coordinate: coord(39.3933, -108.7727) };
  const c = { id: "c", coordinate: coord(40.0562, -105.3) };
  const d = { id: "d", coordinate: coord(38.9489, -104.8863) };

  /** Answers from a table keyed by `lon,lat` as the URL writes it; unknown pairs are unroutable. */
  function fakeOSRM(seconds: Record<string, number | null>): ReturnType<typeof vi.fn<Transport>> {
    return vi.fn<Transport>(async (url) => ({
      status: 200,
      body: okBody(pathCoordinates(url).slice(1).map((pair) => seconds[pair] ?? null)),
    }));
  }

  function pair(dest: { coordinate: Coordinate }): string {
    return `${dest.coordinate.longitude.toFixed(4)},${dest.coordinate.latitude.toFixed(4)}`;
  }

  const ROUTED = { [pair(a)]: 2285, [pair(c)]: 1000.9, [pair(d)]: 6892.5 };

  function failing(): ReturnType<typeof vi.fn<Transport>> {
    return vi.fn<Transport>(async () => {
      throw new Error("offline");
    });
  }

  function stored(map: Map<string, string>): unknown {
    const text = map.get(DRIVE_TIME_CACHE_KEY);
    return text === undefined ? undefined : JSON.parse(text);
  }

  function silenceWarnings(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(console, "warn").mockImplementation(() => undefined);
  }

  it("coldMissRoutesAndCachesRoutedAndUnroutable", async () => {
    const map = new Map<string, string>();
    const transport = fakeOSRM(ROUTED);
    const times = await driveTimesFor(BOULDER, [a, b, c], { transport, cache: mapStore(map) });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(times.get("a")).toEqual({ seconds: 2285, source: "route" });
    expect(times.get("c")).toEqual({ seconds: 1000.9, source: "route" });
    expect(times.get("b")).toEqual({
      seconds: estimateDriveSeconds(BOULDER, b.coordinate),
      source: "estimate",
    });
    expect(stored(map)).toEqual([
      {
        key: "40.01,-105.27",
        times: {
          a: { seconds: 2285, lat: 39.7461, lon: -105.2407 },
          b: { seconds: null, lat: 39.3933, lon: -108.7727 },
          c: { seconds: 1000.9, lat: 40.0562, lon: -105.3 },
        },
      },
    ]);
  });

  it("fullHitMakesNoRequest", async () => {
    const cache = mapStore();
    const first = await driveTimesFor(BOULDER, [a, b, c], { transport: fakeOSRM(ROUTED), cache });
    const transport = failing();
    // Another start in the same 0.01 degree cell.
    const second = await driveTimesFor(coord(40.0149, -105.2651), [a, b, c], { transport, cache });
    expect(transport).not.toHaveBeenCalled();
    expect(second.get("a")).toEqual(first.get("a"));
    expect(second.get("c")).toEqual(first.get("c"));
    expect(second.get("b")?.source).toBe("estimate");
  });

  it("overlappingCallsForDifferentStartsKeepBothInTheCache", async () => {
    const map = new Map<string, string>();
    const cache = mapStore(map);
    const pending: ((response: { status: number; body: string }) => void)[] = [];
    const transport = vi.fn<Transport>(
      () => new Promise((resolve) => void pending.push(resolve)),
    );
    const startA = BOULDER;
    const startB = coord(39.7392, -104.9903);
    const callA = driveTimesFor(startA, [a], { transport, cache });
    const callB = driveTimesFor(startB, [a], { transport, cache });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!({ status: 200, body: okBody([100]) });
    await callA;
    pending[1]!({ status: 200, body: okBody([200]) });
    await callB;
    const keys = (stored(map) as { key: string }[]).map((e) => e.key).sort();
    expect(keys).toEqual([startKey(startA), startKey(startB)].sort());
  });

  it("partialHitRequestsOnlyTheNewDestination", async () => {
    const map = new Map<string, string>();
    const cache = mapStore(map);
    await driveTimesFor(BOULDER, [a, b, c], { transport: fakeOSRM(ROUTED), cache });
    const transport = fakeOSRM(ROUTED);
    const times = await driveTimesFor(BOULDER, [a, b, c, d], { transport, cache });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(pathCoordinates(transport.mock.calls[0]![0])).toEqual(["-105.27,40.01", pair(d)]);
    expect(times.get("d")).toEqual({ seconds: 6892.5, source: "route" });
    expect(times.get("a")).toEqual({ seconds: 2285, source: "route" });
    expect(Object.keys((stored(map) as { times: object }[])[0]!.times).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("aMovedDestinationIsAMiss", async () => {
    const cache = mapStore();
    await driveTimesFor(BOULDER, [a, b], { transport: fakeOSRM(ROUTED), cache });
    const moved = { id: "a", coordinate: coord(39.7462, -105.2407) };
    const transport = fakeOSRM({ [pair(moved)]: 2300 });
    const times = await driveTimesFor(BOULDER, [moved, b], { transport, cache });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(pathCoordinates(transport.mock.calls[0]![0])).toEqual(["-105.27,40.01", pair(moved)]);
    expect(times.get("a")).toEqual({ seconds: 2300, source: "route" });
  });

  it("coordinatesCompareAtFourDecimals", async () => {
    const cache = mapStore();
    await driveTimesFor(BOULDER, [a], { transport: fakeOSRM(ROUTED), cache });
    const jittered = { id: "a", coordinate: coord(39.74612, -105.24069) };
    const transport = failing();
    const times = await driveTimesFor(BOULDER, [jittered], { transport, cache });
    expect(transport).not.toHaveBeenCalled();
    expect(times.get("a")).toEqual({ seconds: 2285, source: "route" });
  });

  it("keepsTheFiveMostRecentStarts", async () => {
    const map = new Map<string, string>();
    const cache = mapStore(map);
    const starts = [0, 1, 2, 3, 4, 5].map((i) => coord(40 + i / 10, -105));
    for (const start of starts) {
      await driveTimesFor(start, [a], { transport: fakeOSRM(ROUTED), cache });
    }
    const keys = (stored(map) as { key: string }[]).map((e) => e.key);
    expect(keys).toEqual(["40.50,-105.00", "40.40,-105.00", "40.30,-105.00", "40.20,-105.00", "40.10,-105.00"]);

    const transport = fakeOSRM(ROUTED);
    await driveTimesFor(starts[0]!, [a], { transport, cache });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("aHitMovesItsStartToTheFront", async () => {
    const map = new Map<string, string>();
    const cache = mapStore(map);
    const other = coord(39, -106);
    await driveTimesFor(BOULDER, [a], { transport: fakeOSRM(ROUTED), cache });
    await driveTimesFor(other, [a], { transport: fakeOSRM(ROUTED), cache });
    await driveTimesFor(BOULDER, [a], { transport: failing(), cache });
    expect((stored(map) as { key: string }[]).map((e) => e.key)).toEqual(["40.01,-105.27", "39.00,-106.00"]);
  });

  it("aFailedFetchEstimatesEverythingAndCachesNothing", async () => {
    const warn = silenceWarnings();
    const map = new Map<string, string>();
    const times = await driveTimesFor(BOULDER, [a, c], { transport: failing(), cache: mapStore(map) });
    expect(times.get("a")).toEqual({ seconds: estimateDriveSeconds(BOULDER, a.coordinate), source: "estimate" });
    expect(times.get("c")).toEqual({ seconds: estimateDriveSeconds(BOULDER, c.coordinate), source: "estimate" });
    expect(map.has(DRIVE_TIME_CACHE_KEY)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("cachedHitsSurviveAFailedFetch", async () => {
    silenceWarnings();
    const map = new Map<string, string>();
    const cache = mapStore(map);
    await driveTimesFor(BOULDER, [a, c], { transport: fakeOSRM(ROUTED), cache });
    const before = map.get(DRIVE_TIME_CACHE_KEY);
    const times = await driveTimesFor(BOULDER, [a, c, d], { transport: failing(), cache });
    expect(times.get("a")).toEqual({ seconds: 2285, source: "route" });
    expect(times.get("d")).toEqual({ seconds: estimateDriveSeconds(BOULDER, d.coordinate), source: "estimate" });
    expect(map.get(DRIVE_TIME_CACHE_KEY)).toBe(before);
  });

  it("anOSRMErrorResponseFallsBackToEstimates", async () => {
    silenceWarnings();
    const transport = vi.fn<Transport>(respond('{"code":"InvalidQuery"}', 400));
    const times = await driveTimesFor(BOULDER, [a], { transport, cache: mapStore() });
    expect(times.get("a")?.source).toBe("estimate");
  });

  it("passesTheBaseURLThrough", async () => {
    const transport = fakeOSRM(ROUTED);
    await driveTimesFor(BOULDER, [a], { transport, cache: mapStore(), baseURL: "http://dead.invalid" });
    expect(transport.mock.calls[0]![0]).toMatch(/^http:\/\/dead\.invalid\/table\/v1\/driving\//);
  });

  it("noDestinationsGivesAnEmptyMap", async () => {
    const transport = fakeOSRM(ROUTED);
    const times = await driveTimesFor(BOULDER, [], { transport, cache: mapStore() });
    expect(times.size).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  const valid = (times: string): string => `[{"key":"40.01,-105.27","times":${times}}]`;

  it.each([
    ["not JSON", "not json {"],
    ["an object, not an array", '{"a":"x"}'],
    ["an entry that is not an object", '["40.01,-105.27"]'],
    ["a key that is not a string", '[{"key":4001,"times":{}}]'],
    ["times as an array", valid("[]")],
    ["a negative time", valid('{"a":{"seconds":-1,"lat":39.7461,"lon":-105.2407}}')],
    ["an infinite time", valid('{"a":{"seconds":1e999,"lat":39.7461,"lon":-105.2407}}')],
    ["a string time", valid('{"a":{"seconds":"2285","lat":39.7461,"lon":-105.2407}}')],
    ["a missing time", valid('{"a":{"lat":39.7461,"lon":-105.2407}}')],
    ["a non-numeric latitude", valid('{"a":{"seconds":99,"lat":"39.7461","lon":-105.2407}}')],
  ])("ignoresAnInvalidCache: %s", async (_name, text) => {
    silenceWarnings();
    const map = new Map([[DRIVE_TIME_CACHE_KEY, text]]);
    const transport = fakeOSRM(ROUTED);
    const times = await driveTimesFor(BOULDER, [a], { transport, cache: mapStore(map) });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(times.get("a")).toEqual({ seconds: 2285, source: "route" });
    expect(stored(map)).toEqual([
      { key: "40.01,-105.27", times: { a: { seconds: 2285, lat: 39.7461, lon: -105.2407 } } },
    ]);
  });

  it("aValidHandWrittenCacheIsRead", async () => {
    const map = new Map([[DRIVE_TIME_CACHE_KEY, valid('{"a":{"seconds":99,"lat":39.7461,"lon":-105.2407}}')]]);
    const transport = failing();
    const times = await driveTimesFor(BOULDER, [a], { transport, cache: mapStore(map) });
    expect(transport).not.toHaveBeenCalled();
    expect(times.get("a")).toEqual({ seconds: 99, source: "route" });
  });

  it("aThrowingGetReadsAsEmpty", async () => {
    silenceWarnings();
    const store: KeyValueStore = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => undefined,
    };
    const times = await driveTimesFor(BOULDER, [a], { transport: fakeOSRM(ROUTED), cache: store });
    expect(times.get("a")).toEqual({ seconds: 2285, source: "route" });
  });

  it("aThrowingSetStillReturnsResults", async () => {
    const warn = silenceWarnings();
    const store: KeyValueStore = {
      get: () => undefined,
      set: () => {
        throw new Error("quota exceeded");
      },
    };
    const times = await driveTimesFor(BOULDER, [a, b], { transport: fakeOSRM(ROUTED), cache: store });
    expect(times.get("a")).toEqual({ seconds: 2285, source: "route" });
    expect(times.get("b")?.source).toBe("estimate");
    expect(warn).toHaveBeenCalled();
  });
});
