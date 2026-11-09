import { isRecord } from "../isRecord";
import type { RemovableStore } from "../keyValueStore";
import type { Launch } from "../sites/site";
import type { DayKey } from "../time";

export const SITE_CACHE_KEY = "will-it-fly/forecast-v2";
/** Entries kept across main and day keys, about 70 KB each. */
export const MAX_CACHED_SITES = 30;
/** The one-blob caches this replaces. */
const LEGACY_KEYS = ["will-it-fly/forecast-v1", "will-it-fly/forecast-v1/day"];
/** A read alone rewrites the blob only when it would move `usedAt` by more than this. */
const USED_AT_RESOLUTION_MS = 60 * 60 * 1000;

/** One site's slices of a response pair (see `splitRaw`). */
export interface CachedSiteForecast {
  /** When the responses were fetched (epoch ms). */
  fetchedAt: number;
  launchRaw: string;
  neighborRaw: string;
}

export interface SiteForecastSave extends CachedSiteForecast {
  key: string;
  launches: readonly Launch[];
}

export interface SiteForecastCommit {
  saves: readonly SiteForecastSave[];
  /** Keys read from this snapshot whose entries were used. */
  used: readonly string[];
  now: number;
}

/** The cache as read once. Storage errors never escape. */
export interface SiteForecastSnapshot {
  /** The entry, if it was fetched for exactly these launches. The slices are not checked here. */
  get(key: string, launches: readonly Launch[]): CachedSiteForecast | undefined;
  /** Applies the saves, marks the used entries and evicts, in at most one write. */
  commit(commit: SiteForecastCommit): void;
}

export interface SiteForecastCache {
  open(): SiteForecastSnapshot;
}

export function mainKey(siteId: string): string {
  return `main:${siteId}`;
}

export function dayKey(day: DayKey, siteId: string): string {
  return `day:${day}:${siteId}`;
}

interface Entry extends CachedSiteForecast {
  /** When a load last used the entry (epoch ms), for least-recently-used eviction. */
  usedAt: number;
  launchesKey: string;
}

/**
 * The responses are arrays matched to launches by position, so an entry is only valid for the same
 * ordered list of the site's launches: ids, coordinates and elevations (the launch request depends on
 * all of them). They are compared as one JSON string.
 */
function launchesKey(launches: readonly Launch[]): string {
  return JSON.stringify(
    launches.map((l) => [l.id, l.coordinate.latitude, l.coordinate.longitude, l.elevationFt]),
  );
}

function parseEntry(value: unknown): Entry | undefined {
  if (!isRecord(value)) return undefined;
  const { fetchedAt, usedAt, launchesKey, launchRaw, neighborRaw } = value;
  if (
    typeof fetchedAt !== "number" ||
    typeof usedAt !== "number" ||
    typeof launchesKey !== "string" ||
    typeof launchRaw !== "string" ||
    typeof neighborRaw !== "string"
  ) {
    return undefined;
  }
  return { fetchedAt, usedAt, launchesKey, launchRaw, neighborRaw };
}

/** The stored entries. A corrupt blob reads as empty and a malformed entry is left out. */
function readEntries(store: RemovableStore): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  try {
    const text = store.get(SITE_CACHE_KEY);
    if (text === undefined) return entries;
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return entries;
    for (const [key, raw] of Object.entries(value)) {
      const entry = parseEntry(raw);
      if (entry !== undefined) entries.set(key, entry);
    }
  } catch (error) {
    console.warn("Could not read the forecast cache", error);
  }
  return entries;
}

/** Eviction order: day entries before main ones, then least recently used first. */
function evictionOrder([aKey, a]: [string, Entry], [bKey, b]: [string, Entry]): number {
  const aDay = aKey.startsWith("day:") ? 0 : 1;
  const bDay = bKey.startsWith("day:") ? 0 : 1;
  return aDay - bDay || a.usedAt - b.usedAt || (aKey < bKey ? -1 : aKey > bKey ? 1 : 0);
}

/**
 * Keeps each site's raw responses under one `localStorage` key, as a map from `mainKey` or `dayKey`
 * to entry. Least recently used entries beyond `MAX_CACHED_SITES` are dropped, but never one this
 * commit saved or used. Removes the legacy cache keys when created.
 */
export function createSiteForecastCache(store: RemovableStore): SiteForecastCache {
  for (const key of LEGACY_KEYS) {
    try {
      store.remove(key);
    } catch (error) {
      console.warn("Could not remove the old forecast cache", error);
    }
  }

  return {
    open() {
      const snapshotEntries = readEntries(store);
      return {
        get(key, launches) {
          const entry = snapshotEntries.get(key);
          if (entry === undefined || entry.launchesKey !== launchesKey(launches)) return undefined;
          const { fetchedAt, launchRaw, neighborRaw } = entry;
          return { fetchedAt, launchRaw, neighborRaw };
        },
        commit({ saves, used, now }) {
          const stale = used.some((key) => {
            const entry = snapshotEntries.get(key);
            return entry !== undefined && now - entry.usedAt > USED_AT_RESOLUTION_MS;
          });
          if (saves.length === 0 && !stale) return;

          // Another load (or tab) may have written since `open()`, so apply this commit to what is
          // stored now, not to the snapshot: otherwise the last writer drops the other's saves.
          const entries = readEntries(store);
          for (const key of used) {
            const entry = entries.get(key);
            if (entry !== undefined) entry.usedAt = now;
          }
          for (const { key, launches, fetchedAt, launchRaw, neighborRaw } of saves) {
            entries.set(key, {
              fetchedAt,
              usedAt: now,
              launchesKey: launchesKey(launches),
              launchRaw,
              neighborRaw,
            });
          }

          const kept = new Set([...saves.map((s) => s.key), ...used.filter((k) => entries.has(k))]);
          const evictable = [...entries].filter(([key]) => !kept.has(key)).sort(evictionOrder);
          const cap = Math.max(MAX_CACHED_SITES, kept.size);
          while (entries.size > cap) {
            const [key] = evictable.shift() ?? [];
            if (key === undefined) break;
            entries.delete(key);
          }

          const write = (): void =>
            store.set(SITE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
          try {
            write();
          } catch {
            for (const [key] of evictable.splice(0, Math.ceil(evictable.length / 2))) {
              entries.delete(key);
            }
            try {
              write();
            } catch (error) {
              console.warn("Could not save the forecast cache", error);
            }
          }
        },
      };
    },
  };
}
