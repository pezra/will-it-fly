import type { KeyValueStore } from "../keyValueStore";
import type { Transport } from "../forecast/openMeteoClient";
import { isRecord } from "../isRecord";
import { tryParseJSON } from "../json";
import { firstLaunchCoordinate } from "../recommendation/ranker";
import { distanceM } from "../sites/coordinate";
import type { Coordinate, Site } from "../sites/site";
import { METERS_PER_MILE, SECONDS_PER_HOUR } from "../units";

/** The speed that turns straight-line miles into an estimated drive time. */
const ESTIMATED_DRIVE_MPH = 40;
/** The fastest a road trip is assumed to go. `withinReach` uses it as a bound, not an estimate. */
export const MAX_ROAD_MPH = 80;
const OSRM_BASE_URL = "https://router.project-osrm.org";
/** How long the UI's transport waits for OSRM before the estimates take over. */
export const OSRM_TIMEOUT_MS = 8000;
/** The most coordinates OSRM accepts in one table request, the start included. */
const OSRM_MAX_COORDS = 100;
/** Starts are rounded to this (about 1 km) before they leave the device or key the cache. */
const ROUTE_PRECISION_DEG = 0.01;
export const DRIVE_TIME_CACHE_KEY = "willItFly.driveTimes.v1";
/** How many rounded starts the cache keeps, most recent first. */
const DRIVE_TIME_CACHE_STARTS = 5;

const STEPS_PER_DEG = Math.round(1 / ROUTE_PRECISION_DEG);
const START_DECIMALS = Math.round(Math.log10(STEPS_PER_DEG));
/** Destinations are sent and compared against the cache at this precision (about 10 m). */
const DESTINATION_DECIMALS = 4;
const OSRM_BATCH_SIZE = OSRM_MAX_COORDS - 1;

/** Seconds from the start to a site, routed by OSRM or estimated from the straight line. */
export interface DriveTime {
  seconds: number;
  source: "route" | "estimate";
}

/** A place to time the drive to. `id` keys the result and the cache. */
export interface Destination {
  id: string;
  coordinate: Coordinate;
}

/** What `driveTimesFor` needs from outside. `baseURL` defaults to `OSRM_BASE_URL`. */
interface DriveTimeDeps {
  transport: Transport;
  cache: KeyValueStore;
  baseURL?: string | undefined;
}

/** `transport`: no response; `api`: a non-`Ok` code; `unexpectedShape`: a body that doesn't parse. */
type DriveTimeErrorKind = "transport" | "http" | "api" | "unexpectedShape";

/** `status` is set only for `http`. `detail` is never empty. */
export class DriveTimeError extends Error {
  readonly kind: DriveTimeErrorKind;
  readonly status: number | undefined;
  readonly detail: string;

  constructor(
    kind: DriveTimeErrorKind,
    detail: string,
    options?: { status?: number; cause?: unknown },
  ) {
    const status = options?.status;
    const prefix =
      kind === "http"
        ? `OSRM HTTP ${status}`
        : kind === "api"
          ? "OSRM error"
          : kind === "transport"
            ? "OSRM request failed"
            : "Unexpected OSRM response";
    super(`${prefix}: ${detail}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DriveTimeError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/** Straight-line distance driven at `ESTIMATED_DRIVE_MPH`, in seconds. */
export function estimateDriveSeconds(from: Coordinate, to: Coordinate): number {
  return (straightLineMiles(from, to) / ESTIMATED_DRIVE_MPH) * SECONDS_PER_HOUR;
}

function straightLineMiles(from: Coordinate, to: Coordinate): number {
  return distanceM(from, to) / METERS_PER_MILE;
}

/**
 * The sites whose first launch is within `MAX_ROAD_MPH` × `hours` straight-line miles of `start`,
 * inclusive. No road trip is faster, so a site dropped here can't be in range. A site with no
 * launch is kept.
 */
export function withinReach(sites: readonly Site[], start: Coordinate, hours: number): Site[] {
  return sites.filter((site) => {
    const first = firstLaunchCoordinate(site);
    return first === undefined || straightLineMiles(start, first) <= MAX_ROAD_MPH * hours;
  });
}

function roundToStep(deg: number): number {
  return Math.round(deg * STEPS_PER_DEG) / STEPS_PER_DEG;
}

/** The start rounded to `ROUTE_PRECISION_DEG`. */
export function roundStart(c: Coordinate): Coordinate {
  return { latitude: roundToStep(c.latitude), longitude: roundToStep(c.longitude) };
}

/** "40.01,-105.27": the rounded start as `lat,lon`. Keys the cache and the UI's fetch. */
export function startKey(c: Coordinate): string {
  const r = roundStart(c);
  return `${r.latitude.toFixed(START_DECIMALS)},${r.longitude.toFixed(START_DECIMALS)}`;
}

function roundDestination(deg: number): number {
  return Number(deg.toFixed(DESTINATION_DECIMALS));
}

// Request

/** OSRM wants `lon,lat`. Hand-joined: URLSearchParams would encode the commas and semicolons. */
function tableURL(start: Coordinate, destinations: readonly Coordinate[], baseURL: string): string {
  const s = roundStart(start);
  const points = [
    `${s.longitude.toFixed(START_DECIMALS)},${s.latitude.toFixed(START_DECIMALS)}`,
    ...destinations.map(
      (d) => `${d.longitude.toFixed(DESTINATION_DECIMALS)},${d.latitude.toFixed(DESTINATION_DECIMALS)}`,
    ),
  ];
  const indices = destinations.map((_, i) => i + 1).join(";");
  const base = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  return `${base}/table/v1/driving/${points.join(";")}?sources=0&destinations=${indices}&annotations=duration`;
}

/**
 * Routed seconds from the rounded start to each destination, in order; undefined where OSRM found
 * no route. Destinations go in batches of `OSRM_MAX_COORDS - 1`, one request at a time, each with the
 * start. Any failed batch rejects the whole call with a `DriveTimeError`.
 */
export async function fetchDriveTimes(
  start: Coordinate,
  destinations: readonly Coordinate[],
  transport: Transport,
  baseURL = OSRM_BASE_URL,
): Promise<(number | undefined)[]> {
  const times: (number | undefined)[] = [];
  for (let i = 0; i < destinations.length; i += OSRM_BATCH_SIZE) {
    const batch = destinations.slice(i, i + OSRM_BATCH_SIZE);
    times.push(...(await loadTable(transport, tableURL(start, batch, baseURL), batch.length)));
  }
  return times;
}

function shape(detail: string, cause?: unknown): DriveTimeError {
  return new DriveTimeError("unexpectedShape", detail, cause === undefined ? undefined : { cause });
}

/** The error code and message from an OSRM body (`{ "code": ..., "message": ... }`), if not `Ok`. */
function apiErrorDetail(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { code, message } = value;
  if (typeof code !== "string" || code === "Ok") return undefined;
  return typeof message === "string" ? `${code}: ${message}` : code;
}

/** OSRM reports a bad query as a 400 with a JSON code, so that is preferred over the bare status. */
async function loadTable(
  transport: Transport,
  url: string,
  count: number,
): Promise<(number | undefined)[]> {
  let response;
  try {
    response = await transport(url);
  } catch (error) {
    throw new DriveTimeError("transport", "no response", { cause: error });
  }
  const { status, body } = response;
  const parsed = tryParseJSON(body);
  if (status === 400) {
    const detail = parsed.ok ? apiErrorDetail(parsed.value) : undefined;
    if (detail !== undefined) throw new DriveTimeError("api", detail);
  }
  if (status !== 200) throw new DriveTimeError("http", "request failed", { status });
  if (!parsed.ok) throw shape("body is not valid JSON", parsed.error);
  const detail = apiErrorDetail(parsed.value);
  if (detail !== undefined) throw new DriveTimeError("api", detail);
  if (!isRecord(parsed.value) || parsed.value["code"] !== "Ok") throw shape("body has no Ok code");
  return durations(parsed.value["durations"], count);
}

function isDuration(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** `durations[0]`: exactly one entry per destination, each seconds or `null`. */
function durations(value: unknown, count: number): (number | undefined)[] {
  const row: unknown = Array.isArray(value) ? value[0] : undefined;
  if (!Array.isArray(row)) throw shape("durations[0] is not an array");
  if (row.length !== count) throw shape(`expected ${count} durations, got ${row.length}`);
  return row.map((x: unknown, i) => {
    if (x === null) return undefined;
    if (!isDuration(x)) throw shape(`duration ${i} is not a non-negative number`);
    return x;
  });
}

// Cache

/** `seconds` is null for a destination OSRM could not route to. */
interface CachedTime {
  seconds: number | null;
  lat: number;
  lon: number;
}

interface CacheEntry {
  key: string;
  times: Record<string, CachedTime>;
}

function parseCachedTime(v: unknown): CachedTime | undefined {
  if (!isRecord(v)) return undefined;
  const { seconds, lat, lon } = v;
  if (seconds !== null && !isDuration(seconds)) return undefined;
  if (typeof lat !== "number" || !Number.isFinite(lat)) return undefined;
  if (typeof lon !== "number" || !Number.isFinite(lon)) return undefined;
  return { seconds, lat, lon };
}

/** The stored entries, or undefined if anything in them is malformed. */
function parseCache(value: unknown): CacheEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: CacheEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const { key, times } = item;
    if (typeof key !== "string" || !isRecord(times)) return undefined;
    const parsed: [string, CachedTime][] = [];
    for (const [id, time] of Object.entries(times)) {
      const t = parseCachedTime(time);
      if (t === undefined) return undefined;
      parsed.push([id, t]);
    }
    entries.push({ key, times: Object.fromEntries(parsed) });
  }
  return entries.slice(0, DRIVE_TIME_CACHE_STARTS);
}

/** Never throws. A missing, unreadable or malformed cache reads as empty. */
function readCache(cache: KeyValueStore): CacheEntry[] {
  try {
    const text = cache.get(DRIVE_TIME_CACHE_KEY);
    if (text === undefined) return [];
    return parseCache(JSON.parse(text)) ?? [];
  } catch (error) {
    console.warn("Could not read the drive-time cache", error);
    return [];
  }
}

function writeCache(cache: KeyValueStore, entries: readonly CacheEntry[]): void {
  try {
    cache.set(DRIVE_TIME_CACHE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn("Could not save the drive-time cache", error);
  }
}

/** The cached time for a destination, if it was stored for the same coordinate. */
function cachedTime(times: Record<string, CachedTime>, dest: Destination): CachedTime | undefined {
  const t = Object.hasOwn(times, dest.id) ? times[dest.id] : undefined;
  if (t === undefined) return undefined;
  const same =
    t.lat === roundDestination(dest.coordinate.latitude) &&
    t.lon === roundDestination(dest.coordinate.longitude);
  return same ? t : undefined;
}

/**
 * A drive time for every destination, keyed by id. Routed times come from the cache (the last
 * `DRIVE_TIME_CACHE_STARTS` rounded starts) or one OSRM fetch for the destinations it lacks. A
 * destination OSRM can't route to, or any destination left over when the fetch fails, gets the
 * straight-line estimate instead. Failed fetches are not cached. Never rejects.
 */
export async function driveTimesFor(
  start: Coordinate,
  destinations: readonly Destination[],
  deps: DriveTimeDeps,
): Promise<Map<string, DriveTime>> {
  const key = startKey(start);
  const entries = readCache(deps.cache);
  const cached = entries.find((e) => e.key === key)?.times ?? {};

  const seconds = new Map<string, number | null>();
  const missing: Destination[] = [];
  for (const dest of destinations) {
    const hit = cachedTime(cached, dest);
    if (hit === undefined) missing.push(dest);
    else seconds.set(dest.id, hit.seconds);
  }

  try {
    const routed = await fetchDriveTimes(
      start,
      missing.map((d) => d.coordinate),
      deps.transport,
      deps.baseURL,
    );
    const fetched = missing.map((dest, i): [string, CachedTime] => [
      dest.id,
      {
        seconds: routed[i] ?? null,
        lat: roundDestination(dest.coordinate.latitude),
        lon: roundDestination(dest.coordinate.longitude),
      },
    ]);
    for (const [id, t] of fetched) seconds.set(id, t.seconds);
    const latest = readCache(deps.cache);
    if (fetched.length > 0 || latest[0]?.key !== key) {
      const current = latest.find((e) => e.key === key)?.times ?? {};
      const merged: CacheEntry = { key, times: { ...current, ...Object.fromEntries(fetched) } };
      const rest = latest.filter((e) => e.key !== key);
      writeCache(deps.cache, [merged, ...rest].slice(0, DRIVE_TIME_CACHE_STARTS));
    }
  } catch (error) {
    console.warn("Could not fetch drive times; using estimates", error);
  }

  return new Map(
    destinations.map((dest): [string, DriveTime] => {
      const s = seconds.get(dest.id);
      return [
        dest.id,
        s === undefined || s === null
          ? { seconds: estimateDriveSeconds(start, dest.coordinate), source: "estimate" }
          : { seconds: s, source: "route" },
      ];
    }),
  );
}
