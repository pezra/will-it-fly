import { offset } from "../sites/coordinate";
import { elevationM } from "../sites/site";
import type { Coordinate, Launch } from "../sites/site";
import { PRESSURE_LEVELS } from "./models";
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

export interface FetchResult {
  forecasts: LaunchForecast[];
  launchRaw: string;
  neighborRaw: string;
}

export const DEFAULT_BASE_URL = "https://api.open-meteo.com";
export const NEIGHBOR_DISTANCE_M = 8047;
export const NEIGHBOR_BEARINGS: readonly number[] = [0, 90, 180, 270];
/** Center point plus N, E, S, W. */
export const NEIGHBOR_POINTS_PER_LAUNCH = 1 + NEIGHBOR_BEARINGS.length;

const LAUNCH_MODELS = ["ecmwf_ifs", "ecmwf_ifs025", "ncep_rrfs_conus"] as const;
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

const LAUNCH_HOURLY_VARIABLES = [
  ...SURFACE_VARIABLES,
  ...PRESSURE_LEVELS.flatMap((level) => LEVEL_VARIABLES.map((v) => `${v}_${level}hPa`)),
];

// Request URLs

interface Point {
  coord: Coordinate;
  elevation: string;
}

export function launchRequestURL(launches: readonly Launch[], baseURL = DEFAULT_BASE_URL): string {
  const points = launches.map((l) => ({
    coord: l.coordinate,
    elevation: elevationM(l).toFixed(1),
  }));
  return makeURL(baseURL, points, LAUNCH_HOURLY_VARIABLES, LAUNCH_MODELS);
}

/**
 * Five points per launch, launch-major: the launch location itself (the "center"), then N, E, S, W.
 *
 * Every point uses `elevation=nan`. With an explicit elevation Open-Meteo picks the grid cell whose
 * terrain best matches it (Crested Butte's launch request landed ~10 km north), whereas `nan` picks the
 * nearest cell. The neighbor check must compare like with like, so the center point is requested with
 * the same `nan` selection as the neighbors rather than reusing the (elevation-matched) launch request.
 */
export function neighborRequestURL(launches: readonly Launch[], baseURL = DEFAULT_BASE_URL): string {
  const points: Point[] = [];
  for (const launch of launches) {
    points.push({ coord: launch.coordinate, elevation: "nan" });
    for (const bearing of NEIGHBOR_BEARINGS) {
      points.push({ coord: offset(launch.coordinate, bearing, NEIGHBOR_DISTANCE_M), elevation: "nan" });
    }
  }
  return makeURL(baseURL, points, ["wind_speed_10m", "wind_direction_10m"], NEIGHBOR_MODELS);
}

/** Hand-joined: URLSearchParams would encode the commas and slashes. */
function makeURL(
  baseURL: string,
  points: readonly Point[],
  hourly: readonly string[],
  models: readonly string[],
): string {
  const items: [string, string][] = [
    ["latitude", points.map((p) => p.coord.latitude.toFixed(4)).join(",")],
    ["longitude", points.map((p) => p.coord.longitude.toFixed(4)).join(",")],
    ["elevation", points.map((p) => p.elevation).join(",")],
    ["hourly", hourly.join(",")],
    ["daily", "sunrise,sunset"],
    ["models", models.join(",")],
    ["wind_speed_unit", "mph"],
    ["timezone", "America/Denver"],
    ["forecast_days", "2"],
    ["timeformat", "unixtime"],
  ];
  const query = items.map(([k, v]) => `${k}=${v}`).join("&");
  const base = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  return `${base}/v1/forecast?${query}`;
}

// Fetch

export interface FetchOptions {
  transport: Transport;
  baseURL?: string;
}

export async function fetchForecasts(
  launches: readonly Launch[],
  options: FetchOptions,
): Promise<FetchResult> {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const [launchRaw, neighborRaw] = await Promise.all([
    load(options.transport, launchRequestURL(launches, baseURL)),
    load(options.transport, neighborRequestURL(launches, baseURL)),
  ]);
  const forecasts = parseForecasts(launchRaw, neighborRaw, launches);
  return { forecasts, launchRaw, neighborRaw };
}

/**
 * Open-Meteo reports a bad request as a 400 with a JSON body, so that reason is preferred over the
 * bare status. Every other non-200 status is `http`, even when its body is error JSON: a 429 must be
 * recognizable as a rate limit.
 */
async function load(transport: Transport, url: string): Promise<string> {
  const { status, body } = await transport(url);
  if (status === 400) {
    const reason = apiErrorReason(body);
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

function tryParseJSON(text: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function apiErrorReason(body: string): string | undefined {
  const parsed = tryParseJSON(body);
  if (!parsed.ok || !isRecord(parsed.value) || parsed.value["error"] !== true) return undefined;
  const reason = parsed.value["reason"];
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

function locations(body: string): Location[] {
  const reason = apiErrorReason(body);
  if (reason !== undefined) throw new OpenMeteoError("api", reason);
  const parsed = tryParseJSON(body);
  if (!parsed.ok) throw shape("body is not valid JSON", parsed.error);
  const value = parsed.value;
  if (Array.isArray(value)) return value.map((el, i) => toLocation(el, `location ${i}`));
  return [toLocation(value, "location")];
}

export function parseForecasts(
  launchBody: string,
  neighborBody: string,
  launches: readonly Launch[],
): LaunchForecast[] {
  const launchLocs = locations(launchBody);
  const neighborLocs = locations(neighborBody);
  const neighborCount = launches.length * NEIGHBOR_POINTS_PER_LAUNCH;
  if (launchLocs.length !== launches.length || neighborLocs.length !== neighborCount) {
    throw shape(
      `expected ${launches.length} launch and ${neighborCount} neighbor locations, got ${launchLocs.length} and ${neighborLocs.length}`,
    );
  }

  return launches.map((launch, index) => {
    const loc = launchLocs[index];
    const hourly = loc?.hourly;
    const times = hourly?.["time"];
    if (loc === undefined || hourly === undefined || times === undefined) {
      throw shape(`launch location ${launch.id} has no hourly time`);
    }
    const dates = times.map(timestamp);

    const ecmwf = dates.map((time, i) => mergedECMWFHour(time, i, hourly));
    const rrfs = dates.map((time, i) => modelHour(time, i, hourly, "ncep_rrfs_conus"));

    const base = index * NEIGHBOR_POINTS_PER_LAUNCH;
    const center = neighborSeries(neighborLocs[base]);
    const neighborCenter: NeighborCenter = {
      ecmwf: neighborWinds(center.dates, center.hourly, "ecmwf_ifs"),
      rrfs: neighborWinds(center.dates, center.hourly, "ncep_rrfs_conus"),
    };
    const neighbors: NeighborForecast[] = NEIGHBOR_BEARINGS.map((bearingDeg, b) => {
      const n = neighborSeries(neighborLocs[base + 1 + b]);
      return {
        bearingDeg,
        ecmwf: neighborWinds(n.dates, n.hourly, "ecmwf_ifs"),
        rrfs: neighborWinds(n.dates, n.hourly, "ncep_rrfs_conus"),
      };
    });
    return {
      launchID: launch.id,
      ecmwf,
      rrfs,
      neighborCenter,
      neighbors,
      days: daylightDays(loc.daily),
    };
  });
}

function neighborSeries(loc: Location | undefined): { hourly: SeriesMap; dates: number[] } {
  const hourly = loc?.hourly;
  const times = hourly?.["time"];
  if (hourly === undefined || times === undefined) throw shape("neighbor location has no hourly time");
  return { hourly, dates: times.map(timestamp) };
}

/** Unix seconds to epoch ms. */
function timestamp(unix: number | null | undefined): number {
  if (unix === null || unix === undefined) throw shape("null timestamp");
  return unix * 1000;
}

/** Daily sunrise/sunset are identical for every model, so use the first model that supplies them. */
function daylightDays(daily: SeriesMap | undefined): DaylightDay[] {
  if (daily === undefined) return [];
  for (const model of LAUNCH_MODELS) {
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

function modelHour(time: number, i: number, hourly: SeriesMap, model: string): ModelHour {
  return { ...surfaceHour(time, i, hourly, model), levels: levels(i, hourly, model) };
}

/** Surface, BLH and low cloud from `ecmwf_ifs`; pressure levels from `ecmwf_ifs025`. */
function mergedECMWFHour(time: number, i: number, hourly: SeriesMap): ModelHour {
  return { ...surfaceHour(time, i, hourly, "ecmwf_ifs"), levels: levels(i, hourly, "ecmwf_ifs025") };
}

function neighborWinds(dates: readonly number[], hourly: SeriesMap, model: string): NeighborWind[] {
  return dates.map((time, i) => ({
    time,
    windMph: value(hourly, "wind_speed_10m", model, i),
    windDir: value(hourly, "wind_direction_10m", model, i),
  }));
}
