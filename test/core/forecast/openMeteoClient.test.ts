import { describe, expect, it } from "vitest";
import {
  fetchForecasts,
  levelsRequestURL,
  NEIGHBOR_POINTS_PER_SITE,
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

/** The recording's sites: each fixture launch alone, in recorded order. */
const recordedSites: Launch[][] = launches.map((l) => [l]);

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
  return parseForecasts(recorded, recordedSites);
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
    expect(surfaceRequestURL(recordedSites)).toBe(surfaceURL.trim());
    expect(levelsRequestURL(recordedSites)).toBe(levelsURL.trim());
    expect(neighborRequestURL(recordedSites)).toBe(neighborsURL.trim());
  });

  it("baseURLTrailingSlashIsIgnored", () => {
    expect(surfaceRequestURL(recordedSites, "https://api.open-meteo.com/")).toBe(surfaceURL.trim());
    expect(levelsRequestURL(recordedSites, "https://api.open-meteo.com/")).toBe(levelsURL.trim());
  });

  it("surfaceURLAsksOnlyForSurfaceVariablesAndDaylightFromECMWFAndRRFS", () => {
    const url = surfaceRequestURL(recordedSites);
    const hourly = (queryParam(url, "hourly") ?? "").split(",");
    expect(hourly).toHaveLength(9);
    expect(hourly.some((v) => v.endsWith("hPa"))).toBe(false);
    expect(queryParam(url, "daily")).toBe("sunrise,sunset");
    expect(queryParam(url, "models")).toBe("ecmwf_ifs,ncep_rrfs_conus");
    expect((queryParam(url, "elevation") ?? "").split(",")).toEqual(["2386.6", "3444.2", "1908.0"]);
  });

  it("levelsURLAsksOnlyForPressureLevelsFromIFS025AndRRFS", () => {
    const url = levelsRequestURL(recordedSites);
    const hourly = (queryParam(url, "hourly") ?? "").split(",");
    expect(hourly).toHaveLength(12);
    expect(hourly.every((v) => v.endsWith("hPa"))).toBe(true);
    expect(queryParam(url, "daily")).toBeUndefined();
    expect(queryParam(url, "models")).toBe("ecmwf_ifs025,ncep_rrfs_conus");
    expect(queryParam(url, "latitude")).toBe(queryParam(surfaceRequestURL(recordedSites), "latitude"));
    expect(queryParam(url, "elevation")).toBe(queryParam(surfaceRequestURL(recordedSites), "elevation"));
  });

  it("singleDayRequestsCarryTheDayInAllThreeURLs", () => {
    for (const url of [
      surfaceRequestURL(recordedSites, undefined, "2026-11-12"),
      levelsRequestURL(recordedSites, undefined, "2026-11-12"),
      neighborRequestURL(recordedSites, undefined, "2026-11-12"),
    ]) {
      expect(queryParam(url, "start_date")).toBe("2026-11-12");
      expect(queryParam(url, "end_date")).toBe("2026-11-12");
      expect(queryParam(url, "forecast_days")).toBeUndefined();
    }
  });

  it("neighborURLHasFivePointsPerSiteCenteredOnTheHighestLaunchAllNan", () => {
    const low = launch("x/low", 39.0, -106.0, 9000);
    const high = launch("x/high", 39.0100, -106.0100, 9500);
    const url = neighborRequestURL([[low, high], [launches[0]!]]);
    const lat = (queryParam(url, "latitude") ?? "").split(",");
    const lon = (queryParam(url, "longitude") ?? "").split(",");
    const elev = (queryParam(url, "elevation") ?? "").split(",");
    expect(lat).toHaveLength(10);
    expect(elev).toHaveLength(10);
    expect(elev.every((e) => e === "nan")).toBe(true);
    // Site-major: center, N, E, S, W. The center is the site's highest launch, even listed second.
    expect([lat[0], lon[0]]).toEqual(["39.0100", "-106.0100"]);
    expect(Number(lat[1])).toBeGreaterThan(39.01);
    expect(Math.abs(Number(lat[2]) - 39.01)).toBeLessThan(0.001);
    expect(Number(lat[3])).toBeLessThan(39.01);
    expect(Number(lat[5])).toBe(39.5428);
  });

  it("aTwoLaunchSiteWithin1000FtAsksForOnePoint", () => {
    const site = [launch("x/upper", 39.0, -106.0, 9000), launch("x/lower", 39.01, -106.01, 8500)];
    for (const url of [surfaceRequestURL([site]), levelsRequestURL([site])]) {
      expect(queryParam(url, "latitude")).toBe("39.0000");
      expect(queryParam(url, "longitude")).toBe("-106.0000");
      expect(queryParam(url, "elevation")).toBe("2743.2");
    }
    expect((queryParam(neighborRequestURL([site]), "latitude") ?? "").split(",")).toHaveLength(5);
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
    const f = parseForecasts({ ...oneLaunch(surface), levels }, [[launches[0]!]])[0]!;
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
      [[launches[0]!]],
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
    const f = parseForecasts(oneLaunch(body), [[launches[0]!]])[0]!;
    expect(f.days).toEqual([{ sunrise: 10_000, sunset: 20_000 }]);
  });

  it("wrongTypesAndNullTimesAreUnexpectedShape", () => {
    const one = [[launches[0]!]];
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
      parseForecasts({ surface: body, levels: body, neighbors: body }, recordedSites);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OpenMeteoError);
      expect((e as OpenMeteoError).kind).toBe("api");
      expect((e as OpenMeteoError).detail).toBe("Latitude must be in range of -90 to 90");
    }
  });

  it("wrongElementCountInAnyBodyIsUnexpectedShape", () => {
    shapeError(() => parseForecasts(recorded, recordedSites.slice(0, 2)));
    // One site of all three launches: 3 points (they are far apart in elevation) but only 5 neighbors.
    shapeError(() => parseForecasts(recorded, [launches]));
    shapeError(() => parseForecasts({ ...recorded, surface: locationsBody(2) }, recordedSites));
    shapeError(() => parseForecasts({ ...recorded, levels: locationsBody(2) }, recordedSites));
    shapeError(() => parseForecasts({ ...recorded, neighbors: locationsBody(14) }, recordedSites));
    const err = shapeError(() => parseForecasts({ ...recorded, surface: "nonsense" }, recordedSites));
    expect(err.cause).toBeDefined();
    shapeError(() => parseForecasts({ ...recorded, levels: "nonsense" }, recordedSites));
  });

  it("differentSurfaceAndLevelsTimesAreUnexpectedShape", () => {
    const surface = '[{"hourly":{"time":[1794034800,1794038400]}}]';
    const one = [[launches[0]!]];
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
    const [a, b] = parseForecasts(
      { surface, levels, neighbors: locationsBody(10) },
      recordedSites.slice(0, 2),
    );
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
    const result = await fetchForecasts(recordedSites, { transport });
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
    await rejection(fetchForecasts(recordedSites, { transport, baseURL: "http://localhost:9/" }));
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
      const err = await rejection(fetchForecasts(recordedSites, { transport }));
      expect(err.status).toBe(503);
    }
  });

  it("fetchMapsHTTPAndAPIErrors", async () => {
    const server: Transport = () => Promise.resolve({ status: 503, body: "busy" });
    const http = await rejection(fetchForecasts(recordedSites, { transport: server }));
    expect(http.kind).toBe("http");
    expect(http.status).toBe(503);

    const api: Transport = () =>
      Promise.resolve({ status: 400, body: '{"error":true,"reason":"nope"}' });
    const apiErr = await rejection(fetchForecasts(recordedSites, { transport: api }));
    expect(apiErr.kind).toBe("api");
    expect(apiErr.detail).toBe("nope");
  });

  it("rateLimitWithErrorJSONIsHTTP429", async () => {
    const limited: Transport = () =>
      Promise.resolve({ status: 429, body: '{"error":true,"reason":"Too many requests"}' });
    const err = await rejection(fetchForecasts(recordedSites, { transport: limited }));
    expect(err.kind).toBe("http");
    expect(err.status).toBe(429);
    expect(err.message).toContain("429");
  });

  it("errorJSONWithStatus200StillThrowsApi", async () => {
    const odd: Transport = () =>
      Promise.resolve({ status: 200, body: '{"error":true,"reason":"odd"}' });
    const err = await rejection(fetchForecasts(recordedSites, { transport: odd }));
    expect(err.kind).toBe("api");
    expect(err.status).toBeUndefined();
  });

  it("splitRawSlicesParseLikeTheWholeResponse", () => {
    // The recorded neighbors are one ring per launch, so only one-launch sites match the recording.
    // The layout test below covers sites with several launches.
    const slices = splitRaw(recorded, recordedSites);
    expect(slices).toHaveLength(3);
    const whole = parsed();
    slices.forEach((slice, i) => {
      expect(JSON.parse(slice.surface)).toHaveLength(1);
      expect(JSON.parse(slice.levels)).toHaveLength(1);
      expect(JSON.parse(slice.neighbors)).toHaveLength(NEIGHBOR_POINTS_PER_SITE);
      // Re-serializing writes the recording's -0 as 0, which is the same number.
      expect(zeroSign(parseForecasts(slice, [recordedSites[i]!]))).toEqual(zeroSign([whole[i]]));
    });
  });

  it("splitRawAcceptsTheSingleObjectResponse", () => {
    const body = '{"hourly":{"time":[1794034800]},"daily":{"time":[1794034800]}}';
    const raw = { surface: body, levels: body, neighbors: locationsBody(5) };
    const [slice, ...rest] = splitRaw(raw, [[launches[0]!]]);
    expect(rest).toEqual([]);
    expect(JSON.parse(slice!.surface)).toEqual([JSON.parse(body)]);
    expect(JSON.parse(slice!.levels)).toEqual([JSON.parse(body)]);
    expect(parseForecasts(slice!, [[launches[0]!]])).toEqual(parseForecasts(raw, [[launches[0]!]]));
  });

  it("splitRawCountMismatchIsUnexpectedShape", () => {
    shapeError(() => splitRaw(recorded, recordedSites.slice(0, 2)));
    shapeError(() => splitRaw(recorded, [...recordedSites, [launches[0]!]]));
    shapeError(() => splitRaw(recorded, [launches]));
    shapeError(() => splitRaw({ ...recorded, surface: locationsBody(2) }, recordedSites));
    shapeError(() => splitRaw({ ...recorded, levels: locationsBody(2) }, recordedSites));
    shapeError(() => splitRaw({ ...recorded, neighbors: locationsBody(14) }, recordedSites));
    shapeError(() => splitRaw({ ...recorded, surface: "nonsense" }, recordedSites));
    shapeError(() => splitRaw({ ...recorded, levels: "nonsense" }, recordedSites));
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

  describe("layout of several sites", () => {
    // C has one launch. B's launches share a coordinate and are listed 8,930, 10,400 and 9,400 ft:
    // the anchor is listed second, 9,400 is exactly 1,000 ft below it, and 8,930 gets its own point.
    // A's two launches share A's one point. Requested as [C, B, A], so the site with two points
    // isn't first, the global points are C0, B0, B1, A0 and the rings start at 0, 5 and 10.
    const c = [launch("c/only", 40.1, -107.1, 7000)];
    const b = [
      launch("b/low", 38.2, -105.2, 8930),
      launch("b/top", 38.2, -105.2, 10400),
      launch("b/mid", 38.2, -105.2, 9400),
    ];
    const a = [launch("a/upper", 39.3, -106.3, 9000), launch("a/lower", 39.31, -106.31, 8500)];
    const sites = [c, b, a];
    /** Each launch's global point and its site's first neighbor, in parse order. */
    const expected = [
      { id: "c/only", point: 0, ring: 0 },
      { id: "b/low", point: 2, ring: 5 },
      { id: "b/top", point: 1, ring: 5 },
      { id: "b/mid", point: 1, ring: 5 },
      { id: "a/upper", point: 3, ring: 10 },
      { id: "a/lower", point: 3, ring: 10 },
    ];
    const hours = [1794034800, 1794038400];
    /** Location `n`'s value at hour `h`: ECMWF n * 100 + h, RRFS 50 more. */
    const enc = (n: number, model: "ecmwf" | "rrfs", h: number): number =>
      n * 100 + (model === "rrfs" ? 50 : 0) + h;
    const series = (n: number, model: "ecmwf" | "rrfs"): number[] => hours.map((_, h) => enc(n, model, h));
    const body = (count: number, location: (n: number) => object): string =>
      JSON.stringify(Array.from({ length: count }, (_, n) => location(n)));

    const raw: ForecastRaw = {
      surface: body(4, (n) => ({
        hourly: {
          time: hours,
          temperature_2m_ecmwf_ifs: series(n, "ecmwf"),
          temperature_2m_ncep_rrfs_conus: series(n, "rrfs"),
          wind_speed_10m_ecmwf_ifs: series(n, "ecmwf"),
          wind_speed_10m_ncep_rrfs_conus: series(n, "rrfs"),
        },
        daily: { sunrise: [n * 1000 + 1], sunset: [n * 1000 + 2] },
      })),
      levels: body(4, (n) => ({
        hourly: {
          time: hours,
          temperature_700hPa_ecmwf_ifs025: series(n, "ecmwf"),
          temperature_700hPa_ncep_rrfs_conus: series(n, "rrfs"),
          wind_speed_700hPa_ecmwf_ifs025: series(n, "ecmwf"),
          wind_speed_700hPa_ncep_rrfs_conus: series(n, "rrfs"),
        },
      })),
      neighbors: body(15, (n) => ({
        hourly: {
          time: hours,
          wind_speed_10m_ecmwf_ifs: series(n, "ecmwf"),
          wind_speed_10m_ncep_rrfs_conus: series(n, "rrfs"),
        },
      })),
    };

    it("eachLaunchGetsItsOwnPointAndItsSitesRing", () => {
      const forecasts = parseForecasts(raw, sites);
      expect(forecasts.map((f) => f.launchID)).toEqual(expected.map((e) => e.id));
      forecasts.forEach((f, i) => {
        const { point, ring } = expected[i]!;
        for (const model of ["ecmwf", "rrfs"] as const) {
          const own = series(point, model);
          expect(f[model].map((h) => h.tempC)).toEqual(own);
          expect(f[model].map((h) => h.windMph)).toEqual(own);
          expect(f[model].map((h) => h.levels[700]?.tempC)).toEqual(own);
          expect(f[model].map((h) => h.levels[700]?.windMph)).toEqual(own);
          expect(f.neighborCenter[model].map((h) => h.windMph)).toEqual(series(ring, model));
          f.neighbors.forEach((n, k) => {
            expect(n[model].map((h) => h.windMph)).toEqual(series(ring + 1 + k, model));
          });
        }
        expect(f.days).toEqual([{ sunrise: (point * 1000 + 1) * 1000, sunset: (point * 1000 + 2) * 1000 }]);
      });
    });

    it("eachLaunchCarriesItsPointsElevation", () => {
      expect(parseForecasts(raw, sites).map((f) => [f.launchID, f.pointElevationFt])).toEqual([
        ["c/only", 7000],
        ["b/low", 8930],
        ["b/top", 10400],
        ["b/mid", 10400],
        ["a/upper", 9000],
        ["a/lower", 9000],
      ]);
    });

    it("theURLsAskForEachSitesPointsInOrderAndOneRingPerSite", () => {
      const elevations = [7000, 10400, 8930, 9000].map((ft) => (ft * 0.3048).toFixed(1));
      for (const url of [surfaceRequestURL(sites), levelsRequestURL(sites)]) {
        expect((queryParam(url, "latitude") ?? "").split(",")).toEqual(["40.1000", "38.2000", "38.2000", "39.3000"]);
        expect((queryParam(url, "elevation") ?? "").split(",")).toEqual(elevations);
      }
      const ring = (queryParam(neighborRequestURL(sites), "latitude") ?? "").split(",");
      expect(ring).toHaveLength(15);
      expect([ring[0], ring[5], ring[10]]).toEqual(["40.1000", "38.2000", "39.3000"]);
    });

    it("splitRawSlicesParseLikeTheWholeLoad", () => {
      const whole = parseForecasts(raw, sites);
      const slices = splitRaw(raw, sites);
      expect(slices.map((s) => (JSON.parse(s.surface) as unknown[]).length)).toEqual([1, 2, 1]);
      expect(slices.map((s) => (JSON.parse(s.levels) as unknown[]).length)).toEqual([1, 2, 1]);
      expect(slices.map((s) => (JSON.parse(s.neighbors) as unknown[]).length)).toEqual([5, 5, 5]);
      let start = 0;
      slices.forEach((slice, i) => {
        const own = sites[i]!;
        expect(parseForecasts(slice, [own])).toEqual(whole.slice(start, start + own.length));
        start += own.length;
      });
    });
  });
});
