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

export const DEFAULT_CACHE_KEY = "flyable-sites/forecast-v1";

interface LaunchKey {
  id: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
}

/**
 * The responses are arrays matched to launches by position, so a cache is only valid for the same
 * ordered list of launches: ids, coordinates and elevations (the launch request depends on all of
 * them).
 */
function launchKeys(launches: readonly Launch[]): LaunchKey[] {
  return launches.map((l) => ({
    id: l.id,
    latitude: l.coordinate.latitude,
    longitude: l.coordinate.longitude,
    elevationFt: l.elevationFt,
  }));
}

function sameKeys(a: readonly LaunchKey[], b: readonly LaunchKey[]): boolean {
  return (
    a.length === b.length &&
    a.every((k, i) => {
      const o = b[i];
      return (
        o !== undefined &&
        k.id === o.id &&
        k.latitude === o.latitude &&
        k.longitude === o.longitude &&
        k.elevationFt === o.elevationFt
      );
    })
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toLaunchKey(v: unknown): LaunchKey | undefined {
  if (!isRecord(v)) return undefined;
  const { id, latitude, longitude, elevationFt } = v;
  if (
    typeof id !== "string" ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    typeof elevationFt !== "number"
  ) {
    return undefined;
  }
  return { id, latitude, longitude, elevationFt };
}

function parseStored(text: string): (CachedForecast & { keys: LaunchKey[] }) | undefined {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) return undefined;
  const { launchRaw, neighborRaw, fetchedAt, launches } = value;
  if (
    typeof launchRaw !== "string" ||
    typeof neighborRaw !== "string" ||
    typeof fetchedAt !== "number" ||
    !Array.isArray(launches)
  ) {
    return undefined;
  }
  const keys: LaunchKey[] = [];
  for (const l of launches) {
    const key = toLaunchKey(l);
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return { launchRaw, neighborRaw, fetchedAt, keys };
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
          JSON.stringify({ launchRaw, neighborRaw, fetchedAt, launches: launchKeys(launches) }),
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
        if (stored === undefined || !sameKeys(stored.keys, launchKeys(launches))) return undefined;
        const { launchRaw, neighborRaw, fetchedAt } = stored;
        return { launchRaw, neighborRaw, fetchedAt };
      } catch (error) {
        console.warn("Could not read the forecast cache", error);
        return undefined;
      }
    },
  };
}
