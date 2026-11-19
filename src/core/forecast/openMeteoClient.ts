import { isRecord } from "../isRecord";
import { tryParseJSON } from "../json";
import { offset } from "../sites/coordinate";
import { elevationM } from "../sites/site";
import type { Coordinate, Launch } from "../sites/site";
import type { DayKey } from "../time";
import { PRESSURE_LEVELS } from "./models";
import { sitePoints } from "./sitePoints";
import type {
  DaylightDay,
  LaunchForecast,
  LevelData,
  ModelHour,
  NeighborCenter,
  NeighborForecast,
  NeighborWind,
  PressureLevel,
} from "./models";

export type OpenMeteoErrorKind = "api" | "http" | "unexpectedShape";

/** `status` is set only for `http`. `detail` is never empty. */
export class OpenMeteoError extends Error {
  readonly kind: OpenMeteoErrorKind;
  readonly status: number | undefined;
  readonly detail: string;

  constructor(
    kind: OpenMeteoErrorKind,
    detail: string,
    options?: { status?: number; cause?: unknown },
  ) {
    const status = options?.status;
    const prefix =
      kind === "http"
        ? status === 429
          ? "Open-Meteo rate limit (HTTP 429)"
          : `Open-Meteo HTTP ${status}`
        : kind === "api"
          ? "Open-Meteo API error"
          : "Unexpected Open-Meteo response";
    super(`${prefix}: ${detail}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenMeteoError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

export interface TransportResponse {
  status: number;
  body: string;
}
export type Transport = (url: string) => Promise<TransportResponse>;

/** The three response bodies of a load, or one site's slice of them (see `splitRaw`). */
export interface ForecastRaw {
  /** The surface variables at each site's points (see `sitePoints`). */
  surface: string;
  /** The pressure-level variables at the same points. */
  levels: string;
  /** The neighbor ring winds. */
  neighbors: string;
}

export interface FetchResult {
  forecasts: LaunchForecast[];
  raw: ForecastRaw;
}

export const DEFAULT_BASE_URL = "https://api.open-meteo.com";
export const NEIGHBOR_DISTANCE_M = 8047;
export const NEIGHBOR_BEARINGS: readonly number[] = [0, 90, 180, 270];
/** Center point plus N, E, S, W. */
export const NEIGHBOR_POINTS_PER_SITE = 1 + NEIGHBOR_BEARINGS.length;

/** The surface request. ECMWF's surface values come from `ecmwf_ifs`. */
const SURFACE_MODELS = ["ecmwf_ifs", "ncep_rrfs_conus"] as const;
/** The levels request. ECMWF's pressure levels come from `ecmwf_ifs025`. */
const LEVEL_MODELS = ["ecmwf_ifs025", "ncep_rrfs_conus"] as const;
const NEIGHBOR_MODELS = ["ecmwf_ifs", "ncep_rrfs_conus"] as const;

const SURFACE_VARIABLES = [
  "temperature_2m",
  "dew_point_2m",
  "precipitation",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "cape",
  "boundary_layer_height",
  "cloud_cover_low",
];
const LEVEL_VARIABLES = ["wind_speed", "wind_direction", "temperature", "geopotential_height"];

const LEVEL_HOURLY_VARIABLES = PRESSURE_LEVELS.flatMap((level) =>
  LEVEL_VARIABLES.map((v) => `${v}_${level}hPa`),
);

// Request URLs

interface Point {
  coord: Coordinate;
  elevation: string;
}

/**
 * The surface variables and the daylight at each site's points (see `sitePoints`), site by site,
 * each at its own elevation. `sites` holds each site's launches.
 */
export function surfaceRequestURL(
  sites: readonly (readonly Launch[])[],
  baseURL = DEFAULT_BASE_URL,
  day?: DayKey,
): string {
  return makeURL(baseURL, forecastPoints(sites), SURFACE_VARIABLES, SURFACE_MODELS, true, day);
}

/** The pressure-level variables at the same points as `surfaceRequestURL`. */
export function levelsRequestURL(
  sites: readonly (readonly Launch[])[],
  baseURL = DEFAULT_BASE_URL,
  day?: DayKey,
): string {
  return makeURL(baseURL, forecastPoints(sites), LEVEL_HOURLY_VARIABLES, LEVEL_MODELS, false, day);
}

function forecastPoints(sites: readonly (readonly Launch[])[]): Point[] {
  return sites.flatMap((launches) =>
    sitePoints(launches).points.map((p) => ({
      coord: p.coordinate,
      elevation: elevationM(p).toFixed(1),
    })),
  );
}

/**
 * Five points per site, site-major: the site's highest launch (the "center"), then N, E, S, W.
 *
 * Every point uses `elevation=nan`. With an explicit elevation Open-Meteo picks the grid cell whose
 * terrain best matches it (a request for Crested Butte's launch landed ~10 km north), whereas `nan` picks the
 * nearest cell. The neighbor check must compare like with like, so the center point is requested with
 * the same `nan` selection as the neighbors rather than reusing the (elevation-matched) site points.
 */
export function neighborRequestURL(
  sites: readonly (readonly Launch[])[],
  baseURL = DEFAULT_BASE_URL,
  day?: DayKey,
): string {
  const points: Point[] = [];
  for (const launches of sites) {
    const center = sitePoints(launches).points[0].coordinate;
    points.push({ coord: center, elevation: "nan" });
    for (const bearing of NEIGHBOR_BEARINGS) {
      points.push({ coord: offset(center, bearing, NEIGHBOR_DISTANCE_M), elevation: "nan" });
    }
  }
  return makeURL(baseURL, points, ["wind_speed_10m", "wind_direction_10m"], NEIGHBOR_MODELS, true, day);
}

/**
 * Hand-joined: URLSearchParams would encode the commas and slashes. Without a `day` it asks for today
 * and tomorrow; with one, for that Denver day only. `daily` adds sunrise and sunset.
 */
function makeURL(
  baseURL: string,
  points: readonly Point[],
  hourly: readonly string[],
  models: readonly string[],
  daily: boolean,
  day?: DayKey,
): string {
  const range: [string, string][] =
    day === undefined
      ? [["forecast_days", "2"]]
      : [
          ["start_date", day],
          ["end_date", day],
        ];
  const items: [string, string][] = [
    ["latitude", points.map((p) => p.coord.latitude.toFixed(4)).join(",")],
    ["longitude", points.map((p) => p.coord.longitude.toFixed(4)).join(",")],
    ["elevation", points.map((p) => p.elevation).join(",")],
    ["hourly", hourly.join(",")],
    ...(daily ? [["daily", "sunrise,sunset"] as [string, string]] : []),
    ["models", models.join(",")],
    ["wind_speed_unit", "mph"],
    ["timezone", "America/Denver"],
    ...range,
    ["timeformat", "unixtime"],
  ];
  const query = items.map(([k, v]) => `${k}=${v}`).join("&");
  const base = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  return `${base}/v1/forecast?${query}`;
}

// Fetch

export interface FetchOptions {
  transport: Transport;
  baseURL?: string | undefined;
  /** Fetch only this Denver day, instead of today and tomorrow. */
  day?: DayKey | undefined;
}

/** `sites` holds each site's launches. The forecasts are as `parseForecasts` returns them. */
export async function fetchForecasts(
  sites: readonly (readonly Launch[])[],
  options: FetchOptions,
): Promise<FetchResult> {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const [surface, levels, neighbors] = await Promise.all([
    load(options.transport, surfaceRequestURL(sites, baseURL, options.day)),
    load(options.transport, levelsRequestURL(sites, baseURL, options.day)),
    load(options.transport, neighborRequestURL(sites, baseURL, options.day)),
  ]);
  const raw = { surface, levels, neighbors };
  return { forecasts: parseForecasts(raw, sites), raw };
}

/**
 * Open-Meteo reports a bad request as a 400 with a JSON body, so that reason is preferred over the
 * bare status. Every other non-200 status is `http`, even when its body is error JSON: a 429 must be
 * recognizable as a rate limit.
 */
async function load(transport: Transport, url: string): Promise<string> {
  const { status, body } = await transport(url);
  if (status === 400) {
    const parsed = tryParseJSON(body);
    const reason = parsed.ok ? apiErrorReason(parsed.value) : undefined;
    if (reason !== undefined) throw new OpenMeteoError("api", reason);
  }
  if (status !== 200) throw new OpenMeteoError("http", "request failed", { status });
  return body;
}

// Parsing

type Series = (number | null)[];
type SeriesMap = Record<string, Series>;

interface Location {
  hourly: SeriesMap | undefined;
  daily: SeriesMap | undefined;
}

function shape(detail: string, cause?: unknown): OpenMeteoError {
  return new OpenMeteoError("unexpectedShape", detail, cause === undefined ? undefined : { cause });
}

/** The reason from an Open-Meteo error body (`{ "error": true, "reason": ... }`), already parsed. */
function apiErrorReason(value: unknown): string | undefined {
  if (!isRecord(value) || value["error"] !== true) return undefined;
  const reason = value["reason"];
  return typeof reason === "string" ? reason : "Unknown API error";
}

function seriesMap(v: unknown, where: string): SeriesMap | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) throw shape(`${where} is not an object`);
  const result: SeriesMap = {};
  for (const [key, series] of Object.entries(v)) {
    if (!Array.isArray(series)) throw shape(`${where}.${key} is not an array`);
    for (const x of series) {
      if (x !== null && typeof x !== "number") throw shape(`${where}.${key} has a non-numeric value`);
    }
    result[key] = series as Series;
  }
  return result;
}

function toLocation(v: unknown, where: string): Location {
  if (!isRecord(v)) throw shape(`${where} is not an object`);
  return {
    hourly: seriesMap(v["hourly"], `${where}.hourly`),
    daily: seriesMap(v["daily"], `${where}.daily`),
  };
}

/** The body's location objects, unchecked. A single-location request answers with a bare object. */
function rawLocations(body: string): unknown[] {
  const parsed = tryParseJSON(body);
  if (!parsed.ok) throw shape("body is not valid JSON", parsed.error);
  const value = parsed.value;
  const reason = apiErrorReason(value);
  if (reason !== undefined) throw new OpenMeteoError("api", reason);
  return Array.isArray(value) ? value : [value];
}

function locations(body: string): Location[] {
  return rawLocations(body).map((el, i) => toLocation(el, `location ${i}`));
}

/**
 * Throws unless the bodies have one surface and one levels location per point, and a ring per site,
 * where `pointCounts` holds each site's number of points.
 */
function checkCounts(
  pointCounts: readonly number[],
  surface: readonly unknown[],
  levels: readonly unknown[],
  neighbors: readonly unknown[],
): void {
  const pointCount = pointCounts.reduce((sum, n) => sum + n, 0);
  const neighborCount = pointCounts.length * NEIGHBOR_POINTS_PER_SITE;
  if (surface.length !== pointCount || levels.length !== pointCount || neighbors.length !== neighborCount) {
    throw shape(
      `expected ${pointCount} surface, ${pointCount} levels and ${neighborCount} neighbor locations, got ${surface.length}, ${levels.length} and ${neighbors.length}`,
    );
  }
}

/**
 * Cuts a load's three bodies into one slice per site, in order, where `sites` holds each site's
 * launches: each site owns its next points (see `sitePoints`) and its ring. Each slice is a valid
 * response for that site alone, so `parseForecasts` reads it as it reads the whole load.
 */
export function splitRaw(raw: ForecastRaw, sites: readonly (readonly Launch[])[]): ForecastRaw[] {
  const surface = rawLocations(raw.surface);
  const levels = rawLocations(raw.levels);
  const neighbors = rawLocations(raw.neighbors);
  const pointCounts = sites.map((launches) => sitePoints(launches).points.length);
  checkCounts(pointCounts, surface, levels, neighbors);
  let start = 0;
  return pointCounts.map((n, i) => {
    const end = start + n;
    const ring = i * NEIGHBOR_POINTS_PER_SITE;
    const slice = {
      surface: JSON.stringify(surface.slice(start, end)),
      levels: JSON.stringify(levels.slice(start, end)),
      neighbors: JSON.stringify(neighbors.slice(ring, ring + NEIGHBOR_POINTS_PER_SITE)),
    };
    start = end;
    return slice;
  });
}

/** One forecast point's series, from its surface and levels locations. */
interface PointForecast {
  ecmwf: ModelHour[];
  rrfs: ModelHour[];
  days: DaylightDay[];
}

function pointForecast(
  surfaceLoc: Location | undefined,
  levelLoc: Location | undefined,
  where: string,
): PointForecast {
  const surface = surfaceLoc?.hourly;
  const times = surface?.["time"];
  if (surfaceLoc === undefined || surface === undefined || times === undefined) {
    throw shape(`${where} has no hourly time`);
  }
  const levelSeries = levelLoc?.hourly;
  const levelTimes = levelSeries?.["time"];
  if (levelSeries === undefined || levelTimes === undefined) {
    throw shape(`${where} has no hourly time in the levels response`);
  }
  if (levelTimes.length !== times.length || levelTimes.some((t, i) => t !== times[i])) {
    throw shape(`${where} has different times in the surface and levels responses`);
  }
  const dates = times.map(timestamp);
  return {
    ecmwf: dates.map((time, i) => ecmwfHour(time, i, surface, levelSeries)),
    rrfs: dates.map((time, i) => rrfsHour(time, i, surface, levelSeries)),
    days: daylightDays(surfaceLoc.daily),
  };
}

/**
 * One forecast per launch, site by site and in launch order within each, where `sites` holds each
 * site's launches. Each launch gets its point's series (see `sitePoints`) and its site's ring.
 * Launches sharing a point share the arrays, as a site's launches share the ring's.
 */
export function parseForecasts(raw: ForecastRaw, sites: readonly (readonly Launch[])[]): LaunchForecast[] {
  const surfaceLocs = locations(raw.surface);
  const levelLocs = locations(raw.levels);
  const neighborLocs = locations(raw.neighbors);
  const layouts = sites.map((launches) => ({ launches, ...sitePoints(launches) }));
  checkCounts(layouts.map(({ points }) => points.length), surfaceLocs, levelLocs, neighborLocs);

  let start = 0;
  return layouts.flatMap(({ launches, points, pointOf }, s) => {
    const series = points.map((_, p) =>
      pointForecast(surfaceLocs[start + p], levelLocs[start + p], `point location ${start + p}`),
    );
    start += points.length;

    const ring = s * NEIGHBOR_POINTS_PER_SITE;
    const neighborCenter = modelWinds(neighborLocs[ring]);
    const neighbors: NeighborForecast[] = NEIGHBOR_BEARINGS.map((bearingDeg, b) => ({
      bearingDeg,
      ...modelWinds(neighborLocs[ring + 1 + b]),
    }));
    return launches.map((launch, i) => {
      const point = series[pointOf[i] ?? -1];
      if (point === undefined) throw new Error(`launch ${launch.id} has no forecast point`);
      const { ecmwf, rrfs, days } = point;
      return { launchID: launch.id, ecmwf, rrfs, neighborCenter, neighbors, days };
    });
  });
}

/** One neighbor-request location's 10 m wind series, per model. */
function modelWinds(loc: Location | undefined): NeighborCenter {
  const hourly = loc?.hourly;
  const times = hourly?.["time"];
  if (hourly === undefined || times === undefined) throw shape("neighbor location has no hourly time");
  const dates = times.map(timestamp);
  return {
    ecmwf: neighborWinds(dates, hourly, "ecmwf_ifs"),
    rrfs: neighborWinds(dates, hourly, "ncep_rrfs_conus"),
  };
}

/** Unix seconds to epoch ms. */
function timestamp(unix: number | null | undefined): number {
  if (unix === null || unix === undefined) throw shape("null timestamp");
  return unix * 1000;
}

/** Daily sunrise/sunset are identical for every model, so use the first model that supplies them. */
function daylightDays(daily: SeriesMap | undefined): DaylightDay[] {
  if (daily === undefined) return [];
  for (const model of SURFACE_MODELS) {
    const rise = daily[`sunrise_${model}`];
    const set = daily[`sunset_${model}`];
    if (rise !== undefined && set !== undefined) return zipDays(rise, set);
  }
  const rise = daily["sunrise"];
  const set = daily["sunset"];
  if (rise !== undefined && set !== undefined) return zipDays(rise, set);
  return [];
}

/** Like Swift's `zip`, truncates to the shorter series. */
function zipDays(rise: Series, set: Series): DaylightDay[] {
  const n = Math.min(rise.length, set.length);
  const days: DaylightDay[] = [];
  for (let i = 0; i < n; i++) {
    days.push({ sunrise: timestamp(rise[i]), sunset: timestamp(set[i]) });
  }
  return days;
}

/** Exact-key lookup. `_ecmwf_ifs` is a prefix of `_ecmwf_ifs025`, so never suffix-match. */
function value(hourly: SeriesMap, variable: string, model: string, i: number): number | undefined {
  return hourly[`${variable}_${model}`]?.[i] ?? undefined;
}

function surfaceHour(time: number, i: number, hourly: SeriesMap, model: string): ModelHour {
  const v = (name: string): number | undefined => value(hourly, name, model, i);
  return {
    time,
    tempC: v("temperature_2m"),
    dewpointC: v("dew_point_2m"),
    precipMm: v("precipitation"),
    windMph: v("wind_speed_10m"),
    windDir: v("wind_direction_10m"),
    gustMph: v("wind_gusts_10m"),
    capeJkg: v("cape"),
    blhM: v("boundary_layer_height"),
    lowCloudPct: v("cloud_cover_low"),
    levels: {},
  };
}

function levels(i: number, hourly: SeriesMap, model: string): Partial<Record<PressureLevel, LevelData>> {
  const result: Partial<Record<PressureLevel, LevelData>> = {};
  for (const p of PRESSURE_LEVELS) {
    result[p] = {
      windMph: value(hourly, `wind_speed_${p}hPa`, model, i),
      windDir: value(hourly, `wind_direction_${p}hPa`, model, i),
      tempC: value(hourly, `temperature_${p}hPa`, model, i),
      heightM: value(hourly, `geopotential_height_${p}hPa`, model, i),
    };
  }
  return result;
}

/** Surface, BLH and low cloud from `ecmwf_ifs`; pressure levels from `ecmwf_ifs025`. */
function ecmwfHour(time: number, i: number, surface: SeriesMap, levelSeries: SeriesMap): ModelHour {
  return { ...surfaceHour(time, i, surface, "ecmwf_ifs"), levels: levels(i, levelSeries, "ecmwf_ifs025") };
}

function rrfsHour(time: number, i: number, surface: SeriesMap, levelSeries: SeriesMap): ModelHour {
  return {
    ...surfaceHour(time, i, surface, "ncep_rrfs_conus"),
    levels: levels(i, levelSeries, "ncep_rrfs_conus"),
  };
}

function neighborWinds(dates: readonly number[], hourly: SeriesMap, model: string): NeighborWind[] {
  return dates.map((time, i) => ({
    time,
    windMph: value(hourly, "wind_speed_10m", model, i),
    windDir: value(hourly, "wind_direction_10m", model, i),
  }));
}
