import { describe, expect, it } from "vitest";
import {
  fetchForecasts,
  levelsRequestURL,
  NEIGHBOR_POINTS_PER_LAUNCH,
  neighborRequestURL,
  OpenMeteoError,
  parseForecasts,
  splitRaw,
  surfaceRequestURL,
} from "../../../src/core/forecast/openMeteoClient";
import type { ForecastRaw, Transport } from "../../../src/core/forecast/openMeteoClient";
import type { LaunchForecast } from "../../../src/core/forecast/models";
import type { Launch } from "../../../src/core/sites/site";
import { denverDayKey, denverHour } from "../../../src/core/time";
import { testLaunch } from "../../support/builders";
import levelsJSON from "../../fixtures/openmeteo-levels.json?raw";
import neighborsJSON from "../../fixtures/openmeteo-neighbors.json?raw";
import surfaceJSON from "../../fixtures/openmeteo-surface.json?raw";
import levelsURL from "../../fixtures/openmeteo-levels.url.txt?raw";
import neighborsURL from "../../fixtures/openmeteo-neighbors.url.txt?raw";
import surfaceURL from "../../fixtures/openmeteo-surface.url.txt?raw";

function launch(id: string, latitude: number, longitude: number, elevationFt: number): Launch {
  return testLaunch({ id, name: id, coordinate: { latitude, longitude }, elevationFt });
}

/** Elevations match sites.json. Ids never reach the URLs. */
const launches: Launch[] = [
  launch("rmhpa/glenwood-lookout-mtn/north", 39.5428, -107.3003, 7830),
  launch("rmhpa/crested-butte/browns", 38.8897, -106.9455, 11300),
  launch("rmhpa/boulder-wonderland/upper", 40.0562, -105.3, 6260),
];

const recorded: ForecastRaw = { surface: surfaceJSON, levels: levelsJSON, neighbors: neighborsJSON };

/** `count` locations that share the one hour the synthetic bodies below use. */
function locationsBody(count: number): string {
  const one = '{"hourly":{"time":[1794034800]},"daily":{"time":[1794034800]}}';
  return `[${Array<string>(count).fill(one).join(",")}]`;
}

/** A launch's raw bodies where only `surface` matters: `levels` and the neighbors have the same hour. */
function oneLaunch(surface: string): ForecastRaw {
  return { surface, levels: locationsBody(1), neighbors: locationsBody(5) };
}

function parsed(): LaunchForecast[] {
  return parseForecasts(recorded, launches);
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
    expect(surfaceRequestURL(launches)).toBe(surfaceURL.trim());
    expect(levelsRequestURL(launches)).toBe(levelsURL.trim());
    expect(neighborRequestURL(launches)).toBe(neighborsURL.trim());
  });

  it("baseURLTrailingSlashIsIgnored", () => {
    expect(surfaceRequestURL(launches, "https://api.open-meteo.com/")).toBe(surfaceURL.trim());
    expect(levelsRequestURL(launches, "https://api.open-meteo.com/")).toBe(levelsURL.trim());
  });

  it("surfaceURLAsksOnlyForSurfaceVariablesAndDaylightFromECMWFAndRRFS", () => {
    const url = surfaceRequestURL(launches);
    const hourly = (queryParam(url, "hourly") ?? "").split(",");
    expect(hourly).toHaveLength(9);
    expect(hourly.some((v) => v.endsWith("hPa"))).toBe(false);
    expect(queryParam(url, "daily")).toBe("sunrise,sunset");
    expect(queryParam(url, "models")).toBe("ecmwf_ifs,ncep_rrfs_conus");
    expect((queryParam(url, "elevation") ?? "").split(",")).toEqual(["2386.6", "3444.2", "1908.0"]);
  });

  it("levelsURLAsksOnlyForPressureLevelsFromIFS025AndRRFS", () => {
    const url = levelsRequestURL(launches);
    const hourly = (queryParam(url, "hourly") ?? "").split(",");
    expect(hourly).toHaveLength(12);
    expect(hourly.every((v) => v.endsWith("hPa"))).toBe(true);
    expect(queryParam(url, "daily")).toBeUndefined();
    expect(queryParam(url, "models")).toBe("ecmwf_ifs025,ncep_rrfs_conus");
    expect(queryParam(url, "latitude")).toBe(queryParam(surfaceRequestURL(launches), "latitude"));
    expect(queryParam(url, "elevation")).toBe(queryParam(surfaceRequestURL(launches), "elevation"));
  });

  it("singleDayRequestsCarryTheDayInAllThreeURLs", () => {
    for (const url of [
      surfaceRequestURL(launches, undefined, "2026-11-12"),
      levelsRequestURL(launches, undefined, "2026-11-12"),
      neighborRequestURL(launches, undefined, "2026-11-12"),
    ]) {
      expect(queryParam(url, "start_date")).toBe("2026-11-12");
      expect(queryParam(url, "end_date")).toBe("2026-11-12");
      expect(queryParam(url, "forecast_days")).toBeUndefined();
    }
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
      // ecmwf_ifs BLH and the ecmwf_ifs025 700 hPa fields are present at every hour.
      expect(f.ecmwf.every((h) => h.blhM !== undefined)).toBe(true);
      expect(
        f.ecmwf.every((h) => h.levels[700]?.windMph !== undefined && h.levels[700]?.heightM !== undefined),
      ).toBe(true);
      expect(f.ecmwf.every((h) => h.windMph !== undefined && h.precipMm !== undefined)).toBe(true);
      expect(f.ecmwf.every((h) => h.levels[500]?.tempC !== undefined)).toBe(true);
    }
  });

  it("recordedResponsesHaveNoSeriesTheParserIgnores", () => {
    // RRFS is complete at all 48 hours. The requests don't ask ecmwf_ifs for pressure levels or
    // ecmwf_ifs025 for surface variables, so the recording has neither.
    const rrfs = parsed().flatMap((f) => f.rrfs);
    expect(
      rrfs.every(
        (h) => h.windMph !== undefined && h.blhM !== undefined && h.levels[500]?.heightM !== undefined,
      ),
    ).toBe(true);
    const surface = rawHourly(surfaceJSON)[0];
    const levels = rawHourly(levelsJSON)[0];
    expect(Object.keys(surface ?? {}).filter((k) => k.includes("hPa") || k.endsWith("ifs025"))).toEqual([]);
    expect(Object.keys(levels ?? {}).filter((k) => !k.includes("hPa") && k !== "time")).toEqual([]);
    expect(Object.keys(levels ?? {}).some((k) => k.endsWith("_ecmwf_ifs"))).toBe(false);
  });

  it("nullsBecomeUndefinedAndKeysDoNotCollide", () => {
    // _ecmwf_ifs is a prefix of _ecmwf_ifs025; each must be read by exact key.
    const surface = `{"hourly":{"time":[1794034800,1794038400],
      "wind_speed_10m_ecmwf_ifs":[10,null],"wind_speed_10m_ecmwf_ifs025":[99,99],
      "wind_speed_10m_ncep_rrfs_conus":[null,null]},
     "daily":{"time":[1794034800],"sunrise":[1794059075],"sunset":[1794096063]}}`;
    const levels = `{"hourly":{"time":[1794034800,1794038400],
      "wind_speed_700hPa_ecmwf_ifs":[77,77],"wind_speed_700hPa_ecmwf_ifs025":[null,25]}}`;
    const f = parseForecasts({ ...oneLaunch(surface), levels }, [launches[0]!])[0]!;
    expect(f.ecmwf.map((h) => h.windMph)).toEqual([10, undefined]);
    expect(f.ecmwf.map((h) => h.levels[700]?.windMph)).toEqual([undefined, 25]);
    expect(f.rrfs.map((h) => h.windMph)).toEqual([undefined, undefined]);
    expect(f.days).toHaveLength(1); // single-object response and unsuffixed daily keys both accepted
    expect(f.neighbors).toHaveLength(4);
  });

  it("missingAndShortSeriesGiveUndefined", () => {
    const body = `[{"hourly":{"time":[1794034800,1794038400],"wind_speed_10m_ncep_rrfs_conus":[5]},
      "daily":{"sunrise":[1,2,3],"sunset":[4,5]}}]`;
    const f = parseForecasts(
      { ...oneLaunch(body), levels: '[{"hourly":{"time":[1794034800,1794038400]}}]' },
      [launches[0]!],
    )[0]!;
    expect(f.rrfs.map((h) => h.windMph)).toEqual([5, undefined]);
    expect(f.ecmwf.map((h) => h.windMph)).toEqual([undefined, undefined]);
    expect(f.days).toEqual([
      { sunrise: 1000, sunset: 4000 },
      { sunrise: 2000, sunset: 5000 },
    ]);
  });

  it("perModelDailyKeysArePreferred", () => {
    const body = `[{"hourly":{"time":[1794034800]},
      "daily":{"sunrise":[1],"sunset":[2],"sunrise_ecmwf_ifs":[10],"sunset_ecmwf_ifs":[20]}}]`;
    const f = parseForecasts(oneLaunch(body), [launches[0]!])[0]!;
    expect(f.days).toEqual([{ sunrise: 10_000, sunset: 20_000 }]);
  });

  it("wrongTypesAndNullTimesAreUnexpectedShape", () => {
    const one = [launches[0]!];
    const parse = (surface: string): unknown => parseForecasts(oneLaunch(surface), one);
    shapeError(() => parse('[{"hourly":{"time":[1],"wind_speed_10m_ecmwf_ifs":["x"]}}]'));
    shapeError(() => parse('[{"hourly":{"time":[1,null]}}]'));
    shapeError(() => parse('[{"hourly":{"wind_speed_10m_ecmwf_ifs":[1]}}]'));
    shapeError(() => parse('[{"daily":{}}]'));
    shapeError(() => parse('[{"hourly":{"time":[1]},"daily":{"sunrise":[null],"sunset":[2]}}]'));
    // The levels body is held to the same checks.
    shapeError(() =>
      parseForecasts({ ...oneLaunch(locationsBody(1)), levels: '[{"hourly":{"time":[1794034800],"x":["x"]}}]' }, one),
    );
    shapeError(() => parseForecasts({ ...oneLaunch(locationsBody(1)), levels: '[{"daily":{}}]' }, one));
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
      parseForecasts({ surface: body, levels: body, neighbors: body }, launches);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OpenMeteoError);
      expect((e as OpenMeteoError).kind).toBe("api");
      expect((e as OpenMeteoError).detail).toBe("Latitude must be in range of -90 to 90");
    }
  });

  it("wrongElementCountInAnyBodyIsUnexpectedShape", () => {
    shapeError(() => parseForecasts(recorded, launches.slice(0, 2)));
    shapeError(() => parseForecasts({ ...recorded, surface: locationsBody(2) }, launches));
    shapeError(() => parseForecasts({ ...recorded, levels: locationsBody(2) }, launches));
    shapeError(() => parseForecasts({ ...recorded, neighbors: locationsBody(14) }, launches));
    const err = shapeError(() => parseForecasts({ ...recorded, surface: "nonsense" }, launches));
    expect(err.cause).toBeDefined();
    shapeError(() => parseForecasts({ ...recorded, levels: "nonsense" }, launches));
  });

  it("differentSurfaceAndLevelsTimesAreUnexpectedShape", () => {
    const surface = '[{"hourly":{"time":[1794034800,1794038400]}}]';
    const one = [launches[0]!];
    const parse = (levels: string): unknown => parseForecasts({ ...oneLaunch(surface), levels }, one);
    parse('[{"hourly":{"time":[1794034800,1794038400]}}]');
    shapeError(() => parse('[{"hourly":{"time":[1794034800,1794042000]}}]'));
    shapeError(() => parse('[{"hourly":{"time":[1794034800]}}]'));
    shapeError(() => parse('[{"hourly":{"time":[1794034800,1794038400,1794042000]}}]'));
  });

  it("everyHourFieldComesFromTheMatchingModelAndBody", () => {
    // Every model x variable x location has its own value, so a field read from the wrong model,
    // the wrong body or the wrong launch can't pass.
    const hours = "[1794034800,1794038400]";
    const surface = `[
      {"hourly":{"time":${hours},
        "wind_speed_10m_ecmwf_ifs":[11,12],"wind_speed_10m_ncep_rrfs_conus":[21,22],
        "temperature_2m_ecmwf_ifs":[31,32],"temperature_2m_ncep_rrfs_conus":[41,42],
        "precipitation_ecmwf_ifs":[0.1,0.2],"precipitation_ncep_rrfs_conus":[0.3,0.4]}},
      {"hourly":{"time":${hours},
        "wind_speed_10m_ecmwf_ifs":[111,112],"wind_speed_10m_ncep_rrfs_conus":[121,122],
        "temperature_2m_ecmwf_ifs":[131,132],"temperature_2m_ncep_rrfs_conus":[141,142],
        "precipitation_ecmwf_ifs":[1.1,1.2],"precipitation_ncep_rrfs_conus":[1.3,1.4]}}]`;
    const levels = `[
      {"hourly":{"time":${hours},
        "wind_speed_700hPa_ecmwf_ifs025":[51,52],"wind_speed_700hPa_ncep_rrfs_conus":[61,62]}},
      {"hourly":{"time":${hours},
        "wind_speed_700hPa_ecmwf_ifs025":[151,152],"wind_speed_700hPa_ncep_rrfs_conus":[161,162]}}]`;
    const [a, b] = parseForecasts({ surface, levels, neighbors: locationsBody(10) }, launches.slice(0, 2));
    const t0 = 1794034800_000;
    const t1 = 1794038400_000;
    expect(a!.ecmwf[0]).toMatchObject({
      time: t0, windMph: 11, tempC: 31, precipMm: 0.1, levels: { 700: { windMph: 51 } },
    });
    expect(a!.ecmwf[1]).toMatchObject({
      time: t1, windMph: 12, tempC: 32, precipMm: 0.2, levels: { 700: { windMph: 52 } },
    });
    expect(a!.rrfs[0]).toMatchObject({
      time: t0, windMph: 21, tempC: 41, precipMm: 0.3, levels: { 700: { windMph: 61 } },
    });
    expect(a!.rrfs[1]).toMatchObject({
      time: t1, windMph: 22, tempC: 42, precipMm: 0.4, levels: { 700: { windMph: 62 } },
    });
    expect(b!.ecmwf[1]).toMatchObject({
      windMph: 112, tempC: 132, precipMm: 1.2, levels: { 700: { windMph: 152 } },
    });
    expect(b!.rrfs[0]).toMatchObject({
      windMph: 121, tempC: 141, precipMm: 1.3, levels: { 700: { windMph: 161 } },
    });
    expect(a!.ecmwf[0]!.gustMph).toBeUndefined();
  });

  it("fetchRoundTripWithStubTransport", async () => {
    const requested: string[] = [];
    const bodies = new Map([
      [surfaceURL.trim(), surfaceJSON],
      [levelsURL.trim(), levelsJSON],
      [neighborsURL.trim(), neighborsJSON],
    ]);
    const transport: Transport = (url) => {
      requested.push(url);
      return Promise.resolve({ status: 200, body: bodies.get(url) ?? "" });
    };
    const result = await fetchForecasts(launches, { transport });
    expect(result.forecasts).toHaveLength(3);
    expect(result.raw).toEqual(recorded);
    expect(requested.sort()).toEqual([...bodies.keys()].sort());
  });

  it("fetchHonorsBaseURL", async () => {
    const requested: string[] = [];
    const transport: Transport = (url) => {
      requested.push(url);
      return Promise.resolve({ status: 500, body: "" });
    };
    await rejection(fetchForecasts(launches, { transport, baseURL: "http://localhost:9/" }));
    expect(requested).toHaveLength(3);
    expect(requested.every((u) => u.startsWith("http://localhost:9/v1/forecast?"))).toBe(true);
  });

  it("anyOneRequestFailingFailsTheFetch", async () => {
    const bodies = new Map([
      [surfaceURL.trim(), surfaceJSON],
      [levelsURL.trim(), levelsJSON],
      [neighborsURL.trim(), neighborsJSON],
    ]);
    for (const failing of bodies.keys()) {
      const transport: Transport = (url) =>
        Promise.resolve(
          url === failing ? { status: 503, body: "busy" } : { status: 200, body: bodies.get(url) ?? "" },
        );
      const err = await rejection(fetchForecasts(launches, { transport }));
      expect(err.status).toBe(503);
    }
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
    const slices = splitRaw(recorded, counts);
    expect(slices).toHaveLength(counts.length);
    const whole = parsed();
    let start = 0;
    slices.forEach((slice, i) => {
      const n = counts[i]!;
      const own = launches.slice(start, start + n);
      expect(JSON.parse(slice.surface)).toHaveLength(n);
      expect(JSON.parse(slice.levels)).toHaveLength(n);
      expect(JSON.parse(slice.neighbors)).toHaveLength(n * NEIGHBOR_POINTS_PER_LAUNCH);
      // Re-serializing writes the recording's -0 as 0, which is the same number.
      expect(zeroSign(parseForecasts(slice, own))).toEqual(
        zeroSign(whole.slice(start, start + n)),
      );
      start += n;
    });
  });

  it("splitRawAcceptsTheSingleObjectResponse", () => {
    const body = '{"hourly":{"time":[1794034800]},"daily":{"time":[1794034800]}}';
    const raw = { surface: body, levels: body, neighbors: locationsBody(5) };
    const [slice, ...rest] = splitRaw(raw, [1]);
    expect(rest).toEqual([]);
    expect(JSON.parse(slice!.surface)).toEqual([JSON.parse(body)]);
    expect(JSON.parse(slice!.levels)).toEqual([JSON.parse(body)]);
    expect(parseForecasts(slice!, [launches[0]!])).toEqual(parseForecasts(raw, [launches[0]!]));
  });

  it("splitRawCountMismatchIsUnexpectedShape", () => {
    shapeError(() => splitRaw(recorded, [1, 1]));
    shapeError(() => splitRaw(recorded, [2, 2]));
    shapeError(() => splitRaw({ ...recorded, surface: locationsBody(2) }, [1, 2]));
    shapeError(() => splitRaw({ ...recorded, levels: locationsBody(2) }, [1, 2]));
    shapeError(() => splitRaw({ ...recorded, neighbors: locationsBody(14) }, [1, 2]));
    shapeError(() => splitRaw({ ...recorded, surface: "nonsense" }, [3]));
    shapeError(() => splitRaw({ ...recorded, levels: "nonsense" }, [3]));
  });

  it("parsedValuesComeFromTheMatchingRawElements", () => {
    const forecasts = parsed();
    const surfaceRaw = rawHourly(surfaceJSON);
    const levelsRaw = rawHourly(levelsJSON);
    const neighborRaw = rawHourly(neighborsJSON);
    const at = (s: RawSeries | undefined, key: string, i: number): number | undefined =>
      s?.[key]?.[i] ?? undefined;
    forecasts.forEach((f, li) => {
      for (const i of [0, 14, 47]) {
        const s = surfaceRaw[li];
        const l = levelsRaw[li];
        expect(f.ecmwf[i]!.blhM).toBe(at(s, "boundary_layer_height_ecmwf_ifs", i));
        expect(f.ecmwf[i]!.windMph).toBe(at(s, "wind_speed_10m_ecmwf_ifs", i));
        expect(f.ecmwf[i]!.levels[700]?.heightM).toBe(at(l, "geopotential_height_700hPa_ecmwf_ifs025", i));
        expect(f.ecmwf[i]!.levels[500]?.windDir).toBe(at(l, "wind_direction_500hPa_ecmwf_ifs025", i));
        expect(f.rrfs[i]!.gustMph).toBe(at(s, "wind_gusts_10m_ncep_rrfs_conus", i));
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
