import { isRecord } from "../isRecord";
import type { Launch } from "../sites/site";

/** The slice of `localStorage` the cache needs. `get` returns undefined for a missing key. */
export interface KeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface CachedForecast {
  launchRaw: string;
  neighborRaw: string;
  /** When the responses were fetched (epoch ms). */
  fetchedAt: number;
}

export interface ForecastCache {
  save(entry: CachedForecast & { launches: readonly Launch[] }): void;
  /** The cached responses, if they were fetched for exactly these launches. Never throws. */
  load(launches: readonly Launch[]): CachedForecast | undefined;
}

export const DEFAULT_CACHE_KEY = "will-it-fly/forecast-v1";

/**
 * The responses are arrays matched to launches by position, so a cache is only valid for the same
 * ordered list of launches: ids, coordinates and elevations (the launch request depends on all of
 * them). They are compared as one JSON string.
 */
function launchesKey(launches: readonly Launch[]): string {
  return JSON.stringify(
    launches.map((l) => [l.id, l.coordinate.latitude, l.coordinate.longitude, l.elevationFt]),
  );
}

function parseStored(text: string): (CachedForecast & { launchesKey: string }) | undefined {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) return undefined;
  const { launchRaw, neighborRaw, fetchedAt, launches } = value;
  if (
    typeof launchRaw !== "string" ||
    typeof neighborRaw !== "string" ||
    typeof fetchedAt !== "number" ||
    typeof launches !== "string"
  ) {
    return undefined;
  }
  return { launchRaw, neighborRaw, fetchedAt, launchesKey: launches };
}

/** Keeps the last successful raw responses as one JSON string. Storage errors never escape. */
export function createForecastCache(
  store: KeyValueStore,
  key: string = DEFAULT_CACHE_KEY,
): ForecastCache {
  return {
    save({ launchRaw, neighborRaw, fetchedAt, launches }) {
      try {
        store.set(
          key,
          JSON.stringify({ launchRaw, neighborRaw, fetchedAt, launches: launchesKey(launches) }),
        );
      } catch (error) {
        console.warn("Could not save the forecast cache", error);
      }
    },
    load(launches) {
      try {
        const text = store.get(key);
        if (text === undefined) return undefined;
        const stored = parseStored(text);
        if (stored === undefined || stored.launchesKey !== launchesKey(launches)) return undefined;
        const { launchRaw, neighborRaw, fetchedAt } = stored;
        return { launchRaw, neighborRaw, fetchedAt };
      } catch (error) {
        console.warn("Could not read the forecast cache", error);
        return undefined;
      }
    },
  };
}
