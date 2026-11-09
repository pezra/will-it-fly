import type { Transport } from "../forecast/openMeteoClient";
import { isRecord } from "../isRecord";
import { tryParseJSON } from "../json";
import type { Coordinate } from "../sites/site";

export const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
/** How long the UI's transport waits for Nominatim before the search reports an error. */
export const GEOCODE_TIMEOUT_MS = 8000;
/** The most candidate places one search asks for. */
const MAX_RESULTS = 5;
const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

/** A search result: Nominatim's full display name and where it is. */
export interface Place {
  name: string;
  coordinate: Coordinate;
}

/** `transport`: no response; `http`: a non-200 status; `unexpectedShape`: a body that isn't a result list. */
type GeocodeErrorKind = "transport" | "http" | "unexpectedShape";

/** `status` is set only for `http`. `detail` is never empty. */
export class GeocodeError extends Error {
  readonly kind: GeocodeErrorKind;
  readonly status: number | undefined;
  readonly detail: string;

  constructor(kind: GeocodeErrorKind, detail: string, options?: { status?: number; cause?: unknown }) {
    const status = options?.status;
    const prefix =
      kind === "http"
        ? `Nominatim HTTP ${status}`
        : kind === "transport"
          ? "Nominatim request failed"
          : "Unexpected Nominatim response";
    super(`${prefix}: ${detail}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GeocodeError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/** The text before the first comma of a display name: "Boulder, Boulder County, …" is "Boulder". */
export function shortPlaceName(name: string): string {
  const comma = name.indexOf(",");
  return (comma < 0 ? name : name.slice(0, comma)).trim();
}

/** Nominatim sends coordinates as strings. Blank or non-numeric text is not a coordinate. */
function parseDegrees(v: unknown, limit: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}

function parsePlace(v: unknown): Place | undefined {
  if (!isRecord(v)) return undefined;
  const latitude = parseDegrees(v["lat"], MAX_LATITUDE);
  const longitude = parseDegrees(v["lon"], MAX_LONGITUDE);
  const name = v["display_name"];
  if (
    latitude === undefined ||
    longitude === undefined ||
    typeof name !== "string" ||
    name.trim() === ""
  ) {
    return undefined;
  }
  return { name, coordinate: { latitude, longitude } };
}

/**
 * Up to five places matching `query`, in Nominatim's order. An empty query makes no request.
 * Results with an unusable name or coordinate are skipped. Rejects with a `GeocodeError`.
 */
export async function searchPlaces(
  query: string,
  transport: Transport,
  baseURL = NOMINATIM_BASE_URL,
): Promise<Place[]> {
  const q = query.trim();
  if (q === "") return [];
  const base = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  const url = `${base}/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=${MAX_RESULTS}`;

  let response;
  try {
    response = await transport(url);
  } catch (error) {
    throw new GeocodeError("transport", "no response", { cause: error });
  }
  if (response.status !== 200) {
    throw new GeocodeError("http", "request failed", { status: response.status });
  }
  const parsed = tryParseJSON(response.body);
  if (!parsed.ok) {
    throw new GeocodeError("unexpectedShape", "body is not valid JSON", { cause: parsed.error });
  }
  if (!Array.isArray(parsed.value)) throw new GeocodeError("unexpectedShape", "body is not a list");
  const places: Place[] = [];
  for (const item of parsed.value as unknown[]) {
    const place = parsePlace(item);
    if (place !== undefined) places.push(place);
    if (places.length === MAX_RESULTS) break;
  }
  return places;
}
