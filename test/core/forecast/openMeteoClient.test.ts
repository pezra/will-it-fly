import { describe, expect, it } from "vitest";
import {
  fetchForecasts,
  launchRequestURL,
  NEIGHBOR_POINTS_PER_LAUNCH,
  neighborRequestURL,
  OpenMeteoError,
  parseForecasts,
  splitRaw,
} from "../../../src/core/forecast/openMeteoClient";
import type { Transport } from "../../../src/core/forecast/openMeteoClient";
import type { LaunchForecast } from "../../../src/core/forecast/models";
import type { Launch } from "../../../src/core/sites/site";
import { denverDayKey, denverHour } from "../../../src/core/time";
import { testLaunch } from "../../support/builders";
import launchesJSON from "../../fixtures/openmeteo-launches.json?raw";
import neighborsJSON from "../../fixtures/openmeteo-neighbors.json?raw";
import launchesURL from "../../fixtures/openmeteo-launches.url.txt?raw";
import neighborsURL from "../../fixtures/openmeteo-neighbors.url.txt?raw";

function launch(id: string, latitude: number, longitude: number, elevationFt: number): Launch {
  return testLaunch({ id, name: id, coordinate: { latitude, longitude }, elevationFt });
}

/** Elevations match sites.json. Ids never reach the URLs. */
const launches: Launch[] = [
  launch("rmhpa/glenwood-lookout-mtn/north", 39.5428, -107.3003, 7830),
  launch("rmhpa/crested-butte/browns", 38.8897, -106.9455, 11300),
  launch("rmhpa/boulder-wonderland/upper", 40.0562, -105.3, 6260),
];

function neighborBody(count: number): string {
  const one = '{"hourly":{"time":[1794034800]},"daily":{"time":[1794034800]}}';
  return `[${Array<string>(count).fill(one).join(",")}]`;
}

function parsed(): LaunchForecast[] {
  return parseForecasts(launchesJSON, neighborsJSON, launches);
}

function queryParam(url: string, name: string): string | undefined {
  const query = url.slice(url.indexOf("?") + 1);
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

function shapeError(fn: () => unknown): OpenMeteoError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OpenMeteoError);
    const err = e as OpenMeteoError;
    expect(err.kind).toBe("unexpectedShape");
    expect(err.detail).not.toBe("");
    return err;
  }
  throw new Error("expected parse to throw");
}

async function rejection(promise: Promise<unknown>): Promise<OpenMeteoError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(OpenMeteoError);
    return e as OpenMeteoError;
  }
  throw new Error("expected fetch to reject");
}

/** `value` through JSON, which writes -0 as 0 (`toEqual` tells them apart). */
function zeroSign(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

type RawSeries =Record<string, (number | null)[]>;
function rawHourly(json: string): RawSeries[] {
  const arr = JSON.parse(json) as { hourly: RawSeries }[];
  return arr.map((el) => el.hourly);
}

describe("OpenMeteoClient", () => {
  it("buildersMatchRecordedURLs", () => {
    expect(launchRequestURL(launches)).toBe(launchesURL.trim());
    expect(neighborRequestURL(launches)).toBe(neighborsURL.trim());
  });

  it("baseURLTrailingSlashIsIgnored", () => {
    expect(launchRequestURL(launches, "https://api.open-meteo.com/")).toBe(launchesURL.trim());
  });

  it("neighborURLHasFourPointsPerLaunchAllNanElevation", () => {
    const url = neighborRequestURL(launches);
    const lat = (queryParam(url, "latitude") ?? "").split(",");
    const elev = (queryParam(url, "elevation") ?? "").split(",");
    expect(lat).toHaveLength(15);
    expect(elev).toHaveLength(15);
    expect(elev.every((e) => e === "nan")).toBe(true);
    // Launch-major: center, N, E, S, W. The center is the launch itself.
    expect(Number(lat[0])).toBe(39.5428);
    expect(Number(lat[1])).toBeGreaterThan(39.5428);
    expect(Math.abs(Number(lat[2]) - 39.5428)).toBeLessThan(0.001);
    expect(Number(lat[3])).toBeLessThan(39.5428);
  });

  it("parsesShapeAndMergesModels", () => {
    const forecasts = parsed();
    expect(forecasts.map((f) => f.launchID)).toEqual(launches.map((l) => l.id));
    for (const f of forecasts) {
      expect(f.ecmwf).toHaveLength(48);
      expect(f.rrfs).toHaveLength(48);
      expect(f.neighbors).toHaveLength(4);
      expect(f.neighborCenter.ecmwf).toHaveLength(48);
      expect(f.neighborCenter.rrfs).toHaveLength(48);
      expect(f.neighbors.map((n) => n.bearingDeg)).toEqual([0, 90, 180, 270]);
      expect(f.neighbors.every((n) => n.ecmwf.length === 48 && n.rrfs.length === 48)).toBe(true);
      expect(f.days).toHaveLength(2);
      // ecmwf_ifs BLH and the merged ecmwf_ifs025 700 hPa fields are present at every hour.
      expect(f.ecmwf.every((h) => h.blhM !== undefined)).toBe(true);
      expect(
        f.ecmwf.every((h) => h.levels[700]?.windMph !== undefined && h.levels[700]?.heightM !== undefined),
      ).toBe(true);
      expect(f.ecmwf.every((h) => h.windMph !== undefined && h.precipMm !== undefined)).toBe(true);
      // ecmwf_ifs's own pressure-level fields are all null and must not leak in; ifs025 BLH likewise.
      expect(f.ecmwf.every((h) => h.levels[500]?.tempC !== undefined)).toBe(true);
    }
  });

  it("recordedNullPositionsComeThroughAsUndefined", () => {
    // In the recording the only nulls are ecmwf_ifs pressure levels and ecmwf_ifs025 BLH, all of which
    // the merge replaces; RRFS is complete at all 48 hours. Assert exactly that.
    const rrfs = parsed().flatMap((f) => f.rrfs);
    expect(
      rrfs.every(
        (h) => h.windMph !== undefined && h.blhM !== undefined && h.levels[500]?.heightM !== undefined,
      ),
    ).toBe(true);
    const hourly = rawHourly(launchesJSON)[0];
    expect(hourly?.["wind_speed_700hPa_ecmwf_ifs"]?.every((x) => x === null)).toBe(true);
    expect(hourly?.["boundary_layer_height_ecmwf_ifs025"]?.every((x) => x === null)).toBe(true);
  });

  it("nullsBecomeUndefinedAndKeysDoNotCollide", () => {
    // _ecmwf_ifs is a prefix of _ecmwf_ifs025; each must be read by exact key.
    const body = `{"hourly":{"time":[1794034800,1794038400],
      "wind_speed_10m_ecmwf_ifs":[10,null],"wind_speed_10m_ecmwf_ifs025":[99,99],
      "wind_speed_700hPa_ecmwf_ifs":[77,77],"wind_speed_700hPa_ecmwf_ifs025":[null,25],
      "wind_speed_10m_ncep_rrfs_conus":[null,null]},
     "daily":{"time":[1794034800],"sunrise":[1794059075],"sunset":[1794096063]}}`;
    const f = parseForecasts(body, neighborBody(5), [launches[0]!])[0]!;
    expect(f.ecmwf.map((h) => h.windMph)).toEqual([10, undefined]);
    expect(f.ecmwf.map((h) => h.levels[700]?.windMph)).toEqual([undefined, 25]);
    expect(f.rrfs.map((h) => h.windMph)).toEqual([undefined, undefined]);
    expect(f.days).toHaveLength(1); // single-object response and unsuffixed daily keys both accepted
    expect(f.neighbors).toHaveLength(4);
  });

  it("missingAndShortSeriesGiveUndefined", () => {
    const body = `[{"hourly":{"time":[1794034800,1794038400],"wind_speed_10m_ncep_rrfs_conus":[5]},
      "daily":{"sunrise":[1,2,3],"sunset":[4,5]}}]`;
    const f = parseForecasts(body, neighborBody(5), [launches[0]!])[0]!;
    expect(f.rrfs.map((h) => h.windMph)).toEqual([5, undefined]);
    expect(f.ecmwf.map((h) => h.windMph)).toEqual([undefined, undefined]);
    expect(f.days).toEqual([
      { sunrise: 1000, sunset: 4000 },
      { sunrise: 2000, sunset: 5000 },
    ]);
  });

  it("perModelDailyKeysArePreferred", () => {
    const body = `[{"hourly":{"time":[1794034800]},
      "daily":{"sunrise":[1],"sunset":[2],"sunrise_ecmwf_ifs025":[10],"sunset_ecmwf_ifs025":[20]}}]`;
    const f = parseForecasts(body, neighborBody(5), [launches[0]!])[0]!;
    expect(f.days).toEqual([{ sunrise: 10_000, sunset: 20_000 }]);
  });

  it("wrongTypesAndNullTimesAreUnexpectedShape", () => {
    const nb = neighborBody(5);
    const one = [launches[0]!];
    shapeError(() => parseForecasts('[{"hourly":{"time":[1],"wind_speed_10m_ecmwf_ifs":["x"]}}]', nb, one));
    shapeError(() => parseForecasts('[{"hourly":{"time":[1,null]}}]', nb, one));
    shapeError(() => parseForecasts('[{"hourly":{"wind_speed_10m_ecmwf_ifs":[1]}}]', nb, one));
    shapeError(() => parseForecasts('[{"daily":{}}]', nb, one));
    shapeError(() =>
      parseForecasts('[{"hourly":{"time":[1]},"daily":{"sunrise":[null],"sunset":[2]}}]', nb, one),
    );
  });

  it("datesDecodeToDenverLocalTime", () => {
    const f = parsed()[0]!;
    const first = f.ecmwf[0]!.time;
    expect(denverDayKey(first)).toBe("2026-11-07");
    expect(denverHour(first)).toBe(0);
    expect(first % 3_600_000).toBe(0);
    expect(f.ecmwf[1]!.time - first).toBe(3_600_000);
    const last = f.ecmwf[47]!.time;
    expect(denverDayKey(last)).toBe("2026-11-08");
    expect(denverHour(last)).toBe(23);
    // Sunrise before sunset, both on the right local day, in the plausible range for Nov in Colorado.
    const day0 = f.days[0]!;
    expect(day0.sunrise).toBeLessThan(day0.sunset);
    expect(denverHour(day0.sunrise)).toBeGreaterThanOrEqual(6);
    expect(denverHour(day0.sunrise)).toBeLessThanOrEqual(8);
    expect(denverHour(day0.sunset)).toBeGreaterThanOrEqual(16);
    expect(denverHour(day0.sunset)).toBeLessThanOrEqual(18);
    expect(denverDayKey(f.days[1]!.sunrise)).toBe("2026-11-08");
  });

  it("apiErrorBodyThrowsApiError", () => {
    const body = '{"error":true,"reason":"Latitude must be in range of -90 to 90"}';
    try {
      parseForecasts(body, body, launches);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OpenMeteoError);
      expect((e as OpenMeteoError).kind).toBe("api");
      expect((e as OpenMeteoError).detail).toBe("Latitude must be in range of -90 to 90");
    }
  });

  it("wrongElementCountIsUnexpectedShape", () => {
    shapeError(() => parseForecasts(launchesJSON, neighborsJSON, launches.slice(0, 2)));
    shapeError(() => parseForecasts(launchesJSON, neighborBody(14), launches));
    const err = shapeError(() => parseForecasts("nonsense", neighborsJSON, launches));
    expect(err.cause).toBeDefined();
  });

  it("fetchRoundTripWithStubTransport", async () => {
    const requested: string[] = [];
    const transport: Transport = (url) => {
      requested.push(url);
      // The neighbor request asks only for 10 m wind; the launch request asks for everything.
      const isNeighbor = url.includes("hourly=wind_speed_10m,wind_direction_10m&");
      return Promise.resolve({ status: 200, body: isNeighbor ? neighborsJSON : launchesJSON });
    };
    const result = await fetchForecasts(launches, { transport });
    expect(result.forecasts).toHaveLength(3);
    expect(result.launchRaw).toBe(launchesJSON);
    expect(result.neighborRaw).toBe(neighborsJSON);
    expect(requested.sort()).toEqual([launchesURL.trim(), neighborsURL.trim()].sort());
  });

  it("fetchHonorsBaseURL", async () => {
    const requested: string[] = [];
    const transport: Transport = (url) => {
      requested.push(url);
      return Promise.resolve({ status: 500, body: "" });
    };
    await rejection(fetchForecasts(launches, { transport, baseURL: "http://localhost:9/" }));
    expect(requested).toHaveLength(2);
    expect(requested.every((u) => u.startsWith("http://localhost:9/v1/forecast?"))).toBe(true);
  });

  it("fetchMapsHTTPAndAPIErrors", async () => {
    const server: Transport = () => Promise.resolve({ status: 503, body: "busy" });
    const http = await rejection(fetchForecasts(launches, { transport: server }));
    expect(http.kind).toBe("http");
    expect(http.status).toBe(503);

    const api: Transport = () =>
      Promise.resolve({ status: 400, body: '{"error":true,"reason":"nope"}' });
    const apiErr = await rejection(fetchForecasts(launches, { transport: api }));
    expect(apiErr.kind).toBe("api");
    expect(apiErr.detail).toBe("nope");
  });

  it("rateLimitWithErrorJSONIsHTTP429", async () => {
    const limited: Transport = () =>
      Promise.resolve({ status: 429, body: '{"error":true,"reason":"Too many requests"}' });
    const err = await rejection(fetchForecasts(launches, { transport: limited }));
    expect(err.kind).toBe("http");
    expect(err.status).toBe(429);
    expect(err.message).toContain("429");
  });

  it("errorJSONWithStatus200StillThrowsApi", async () => {
    const odd: Transport = () =>
      Promise.resolve({ status: 200, body: '{"error":true,"reason":"odd"}' });
    const err = await rejection(fetchForecasts(launches, { transport: odd }));
    expect(err.kind).toBe("api");
    expect(err.status).toBeUndefined();
  });

  it.each([
    [[1, 2]],
    [[2, 1]],
    [[1, 1, 1]],
  ])("splitRawSlicesParseLikeTheWholeResponse: %j", (counts) => {
    const slices = splitRaw(launchesJSON, neighborsJSON, counts);
    expect(slices).toHaveLength(counts.length);
    const whole = parsed();
    let start = 0;
    slices.forEach((slice, i) => {
      const n = counts[i]!;
      const own = launches.slice(start, start + n);
      expect(JSON.parse(slice.launchRaw)).toHaveLength(n);
      expect(JSON.parse(slice.neighborRaw)).toHaveLength(n * NEIGHBOR_POINTS_PER_LAUNCH);
      // Re-serializing writes the recording's -0 as 0, which is the same number.
      expect(zeroSign(parseForecasts(slice.launchRaw, slice.neighborRaw, own))).toEqual(
        zeroSign(whole.slice(start, start + n)),
      );
      start += n;
    });
  });

  it("splitRawAcceptsTheSingleObjectResponse", () => {
    const body = '{"hourly":{"time":[1794034800]},"daily":{"time":[1794034800]}}';
    const [slice, ...rest] = splitRaw(body, neighborBody(5), [1]);
    expect(rest).toEqual([]);
    expect(JSON.parse(slice!.launchRaw)).toEqual([JSON.parse(body)]);
    expect(parseForecasts(slice!.launchRaw, slice!.neighborRaw, [launches[0]!])).toEqual(
      parseForecasts(body, neighborBody(5), [launches[0]!]),
    );
  });

  it("splitRawCountMismatchIsUnexpectedShape", () => {
    shapeError(() => splitRaw(launchesJSON, neighborsJSON, [1, 1]));
    shapeError(() => splitRaw(launchesJSON, neighborsJSON, [2, 2]));
    shapeError(() => splitRaw(launchesJSON, neighborBody(14), [1, 2]));
    shapeError(() => splitRaw("nonsense", neighborsJSON, [3]));
  });

  it("parsedValuesComeFromTheMatchingRawElements", () => {
    const forecasts = parsed();
    const launchRaw = rawHourly(launchesJSON);
    const neighborRaw = rawHourly(neighborsJSON);
    const at = (s: RawSeries | undefined, key: string, i: number): number | undefined =>
      s?.[key]?.[i] ?? undefined;
    forecasts.forEach((f, li) => {
      for (const i of [0, 14, 47]) {
        const l = launchRaw[li];
        expect(f.ecmwf[i]!.blhM).toBe(at(l, "boundary_layer_height_ecmwf_ifs", i));
        expect(f.ecmwf[i]!.windMph).toBe(at(l, "wind_speed_10m_ecmwf_ifs", i));
        expect(f.ecmwf[i]!.levels[700]?.heightM).toBe(at(l, "geopotential_height_700hPa_ecmwf_ifs025", i));
        expect(f.ecmwf[i]!.levels[500]?.windDir).toBe(at(l, "wind_direction_500hPa_ecmwf_ifs025", i));
        expect(f.rrfs[i]!.gustMph).toBe(at(l, "wind_gusts_10m_ncep_rrfs_conus", i));
        expect(f.rrfs[i]!.levels[600]?.tempC).toBe(at(l, "temperature_600hPa_ncep_rrfs_conus", i));
        const c = neighborRaw[li * 5];
        expect(f.neighborCenter.ecmwf[i]!.windMph).toBe(at(c, "wind_speed_10m_ecmwf_ifs", i));
        expect(f.neighborCenter.rrfs[i]!.windDir).toBe(at(c, "wind_direction_10m_ncep_rrfs_conus", i));
        f.neighbors.forEach((n, b) => {
          const r = neighborRaw[li * 5 + 1 + b];
          expect(n.ecmwf[i]!.windMph).toBe(at(r, "wind_speed_10m_ecmwf_ifs", i));
          expect(n.rrfs[i]!.windDir).toBe(at(r, "wind_direction_10m_ncep_rrfs_conus", i));
        });
      }
    });
    // Launches genuinely differ, so a wrong index mapping could not pass by coincidence.
    expect(forecasts[0]!.ecmwf[14]!.levels[700]?.heightM).not.toBe(
      forecasts[1]!.ecmwf[14]!.levels[700]?.heightM,
    );
  });
});
