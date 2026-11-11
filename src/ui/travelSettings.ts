import type { KeyValueStore } from "../core/keyValueStore";
import { isRecord } from "../core/isRecord";
import type { Coordinate, SiteKind } from "../core/sites/site";
import { MINUTES_PER_HOUR, SECONDS_PER_MINUTE } from "../core/units";

/** The `localStorage` key the travel settings are stored under. */
const TRAVEL_SETTINGS_KEY = "willItFly.travel.v1";
/** The flying radius choices in hours. The single definition: the UI and the parser both read it. */
const DRIVE_HOUR_CHOICES = [1, 2, 3, 4] as const;
/** A flying drive limit in whole hours. */
export type MaxHours = (typeof DRIVE_HOUR_CHOICES)[number];
/** The flying radius used when nothing is stored. */
const DEFAULT_MAX_HOURS: MaxHours = 2;
/** The Kite radius choices in minutes. */
const KITE_MINUTE_CHOICES = [15, 30, 60] as const;
/** A Kite drive limit in minutes. */
export type KiteMinutes = (typeof KITE_MINUTE_CHOICES)[number];
/** The Kite radius used when nothing valid is stored. */
const DEFAULT_KITE_MINUTES: KiteMinutes = 30;

/**
 * The radius choices for each mode, in minutes: what the UI offers. The stored fields keep their
 * own units (hours, minutes), which nothing outside this file reads.
 */
export const RADIUS_CHOICES: Readonly<Record<SiteKind, readonly number[]>> = {
  flying: DRIVE_HOUR_CHOICES.map((hours) => hours * MINUTES_PER_HOUR),
  kiting: KITE_MINUTE_CHOICES,
};

/** Where the drive is timed from: the device's location, or a place the user searched for. */
export type TravelStart = { kind: "geolocation" } | { kind: "place"; name: string; coordinate: Coordinate };

/**
 * The user's start point and drive limits, as stored between visits. The two modes keep their own
 * radius (`maxHours` for flying sites, `kiteMinutes` for kiting sites); the start is shared. Only
 * this file reads the two fields: everything else goes through `radiusMinutes` and `withRadius`.
 */
export interface TravelSettings {
  start: TravelStart;
  maxHours: MaxHours;
  kiteMinutes: KiteMinutes;
}

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;
/** The longest place name that is stored; a longer one reads back as the defaults. */
export const MAX_PLACE_NAME_LENGTH = 120;

/** Fresh settings for when nothing valid is stored: start from the location, the default radius. */
export function defaultTravelSettings(): TravelSettings {
  return { start: { kind: "geolocation" }, maxHours: DEFAULT_MAX_HOURS, kiteMinutes: DEFAULT_KITE_MINUTES };
}

/** The drive limit for `mode`, in minutes. */
export function radiusMinutes(settings: TravelSettings, mode: SiteKind): number {
  return mode === "kiting" ? settings.kiteMinutes : settings.maxHours * MINUTES_PER_HOUR;
}

/**
 * The settings with `mode`'s drive limit set to `minutes`. A value that isn't one of the mode's
 * `RADIUS_CHOICES` is ignored and the settings come back as they were.
 */
export function withRadius(settings: TravelSettings, mode: SiteKind, minutes: number): TravelSettings {
  if (!RADIUS_CHOICES[mode].includes(minutes)) return settings;
  return mode === "kiting"
    ? { ...settings, kiteMinutes: minutes as KiteMinutes }
    : { ...settings, maxHours: (minutes / MINUTES_PER_HOUR) as MaxHours };
}

/** The drive limit for `mode`, in seconds. */
export function maxSeconds(settings: TravelSettings, mode: SiteKind): number {
  return radiusMinutes(settings, mode) * SECONDS_PER_MINUTE;
}

/** A radius as the UI says it: "15 min", "30 min", "1 h", "2 h". Whole hours read as hours. */
export function radiusLabel(minutes: number): string {
  return minutes % MINUTES_PER_HOUR === 0 ? `${minutes / MINUTES_PER_HOUR} h` : `${minutes} min`;
}

function isFiniteIn(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

function parseCoordinate(value: unknown): Coordinate | undefined {
  if (!isRecord(value)) return undefined;
  const { latitude, longitude } = value;
  if (!isFiniteIn(latitude, MAX_LATITUDE) || !isFiniteIn(longitude, MAX_LONGITUDE)) return undefined;
  return { latitude, longitude };
}

function parseStart(value: unknown): TravelStart | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "geolocation") return { kind: "geolocation" };
  if (value.kind !== "place") return undefined;
  const { name } = value;
  const coordinate = parseCoordinate(value.coordinate);
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_PLACE_NAME_LENGTH) {
    return undefined;
  }
  if (coordinate === undefined) return undefined;
  return { kind: "place", name, coordinate };
}

function parseMaxHours(value: unknown): MaxHours | undefined {
  // "any" was a choice once; it reads as the default so the stored start survives.
  if (value === "any") return DEFAULT_MAX_HOURS;
  return (DRIVE_HOUR_CHOICES as readonly unknown[]).includes(value)
    ? (value as MaxHours)
    : undefined;
}

/** The Kite radius; one that was never stored (older settings) or isn't a choice reads as the default. */
function parseKiteMinutes(value: unknown): KiteMinutes {
  return (KITE_MINUTE_CHOICES as readonly unknown[]).includes(value)
    ? (value as KiteMinutes)
    : DEFAULT_KITE_MINUTES;
}

/**
 * Rebuilds the settings from stored JSON. An invalid start or flying radius makes the whole value
 * the defaults; a missing or invalid Kite radius reads as the default and keeps the rest.
 */
function parseSettings(value: unknown): TravelSettings | undefined {
  if (!isRecord(value)) return undefined;
  const start = parseStart(value.start);
  const maxHours = parseMaxHours(value.maxHours);
  if (start === undefined || maxHours === undefined) return undefined;
  return { start, maxHours, kiteMinutes: parseKiteMinutes(value.kiteMinutes) };
}

/** The stored travel settings, or fresh defaults when they are missing or invalid. Never throws. */
export function loadTravelSettings(store: KeyValueStore): TravelSettings {
  try {
    const text = store.get(TRAVEL_SETTINGS_KEY);
    if (text === undefined) return defaultTravelSettings();
    return parseSettings(JSON.parse(text)) ?? defaultTravelSettings();
  } catch (error) {
    console.warn("Could not read the travel settings", error);
    return defaultTravelSettings();
  }
}

/** Stores the travel settings. A failed write is logged, not thrown. */
export function saveTravelSettings(store: KeyValueStore, settings: TravelSettings): void {
  try {
    store.set(TRAVEL_SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Could not save the travel settings", error);
  }
}
