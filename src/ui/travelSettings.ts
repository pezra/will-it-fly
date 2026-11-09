import type { KeyValueStore } from "../core/forecast/forecastCache";
import { isRecord } from "../core/isRecord";
import type { Coordinate } from "../core/sites/site";
import { SECONDS_PER_HOUR } from "../core/units";

/** The `localStorage` key the travel settings are stored under. */
const TRAVEL_SETTINGS_KEY = "willItFly.travel.v1";
/** The radius choices in hours. The single definition: the UI and the parser both read it. */
export const DRIVE_HOUR_CHOICES = [1, 2, 3, 4] as const;
/** A drive limit in whole hours. */
export type MaxHours = (typeof DRIVE_HOUR_CHOICES)[number];
/** The radius used when nothing is stored. */
const DEFAULT_MAX_HOURS: MaxHours = 2;

/** Where the drive is timed from: the device's location, or a place the user searched for. */
export type TravelStart = { kind: "geolocation" } | { kind: "place"; name: string; coordinate: Coordinate };

/** The user's start point and drive limit, as stored between visits. */
export interface TravelSettings {
  start: TravelStart;
  maxHours: MaxHours;
}

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;
/** The longest place name that is stored; a longer one reads back as the defaults. */
export const MAX_PLACE_NAME_LENGTH = 120;

/** Fresh settings for when nothing valid is stored: start from the location, the default radius. */
export function defaultTravelSettings(): TravelSettings {
  return { start: { kind: "geolocation" }, maxHours: DEFAULT_MAX_HOURS };
}

/** The drive limit in seconds. */
export function maxSeconds(settings: TravelSettings): number {
  return settings.maxHours * SECONDS_PER_HOUR;
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

/** Rebuilds the settings from stored JSON. Any invalid field makes the whole value the defaults. */
function parseSettings(value: unknown): TravelSettings | undefined {
  if (!isRecord(value)) return undefined;
  const start = parseStart(value.start);
  const maxHours = parseMaxHours(value.maxHours);
  if (start === undefined || maxHours === undefined) return undefined;
  return { start, maxHours };
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
