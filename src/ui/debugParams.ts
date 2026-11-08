import type { Coordinate } from "../core/sites/site";

/**
 * Verification aids, read from the query string. They are honored only in dev builds
 * (`import.meta.env.DEV`), so a production build ignores them (and the bundler drops this code).
 *
 *   ?now=<ISO 8601>       pretend it is this time (a fixed clock)
 *   ?base=<URL>           Open-Meteo base URL (e.g. an unreachable host, to force a fetch failure)
 *   ?lat=..&lon=..        fake location
 *   ?nolocation           behave as if location were denied
 */
export interface DebugParams {
  now?: number;
  baseURL?: string;
  location?: Coordinate;
  noLocation?: boolean;
}

export function parseDebugParams(search: string): DebugParams {
  const params = new URLSearchParams(search);
  const debug: DebugParams = {};

  const nowText = params.get("now");
  if (nowText !== null) {
    const now = Date.parse(nowText);
    if (Number.isNaN(now)) console.warn(`Ignoring ?now=${nowText}: not an ISO 8601 time`);
    else debug.now = now;
  }

  const base = params.get("base");
  if (base !== null && base !== "") debug.baseURL = base;

  const lat = params.get("lat");
  const lon = params.get("lon");
  if (lat !== null && lon !== null) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (lat !== "" && lon !== "" && Number.isFinite(latitude) && Number.isFinite(longitude)) {
      debug.location = { latitude, longitude };
    }
  }

  if (params.has("nolocation")) debug.noLocation = true;
  return debug;
}

/** The debug params for this page load: always empty outside `npm run dev`. */
export function currentDebugParams(): DebugParams {
  return import.meta.env.DEV ? parseDebugParams(window.location.search) : {};
}
