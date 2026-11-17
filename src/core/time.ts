export const DENVER = "America/Denver";

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DENVER,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
});

type PartType = "year" | "month" | "day" | "hour";

/** The Denver calendar parts of ms, from a single `formatToParts` call. */
function parts(ms: number): Record<PartType, string> {
  const found = new Map<string, string>(partsFormat.formatToParts(ms).map((p) => [p.type, p.value]));
  const get = (type: PartType): string => {
    const value = found.get(type);
    if (value === undefined) throw new Error(`Intl returned no ${type} part`);
    return value;
  };
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

/** Calendar day in America/Denver, as "YYYY-MM-DD". */
export function denverDayKey(ms: number): string {
  const { year, month, day } = parts(ms);
  return `${year}-${month}-${day}`;
}

/** Hour of day (0-23) in America/Denver. */
export function denverHour(ms: number): number {
  return Number(parts(ms).hour);
}

/** "HH:00" for the Denver hour containing ms. */
export function formatDenverTime(ms: number): string {
  return `${String(denverHour(ms)).padStart(2, "0")}:00`;
}

/** One hour in milliseconds. */
export const HOUR_MS = 3_600_000;

/** Indexes items by their `time`. A later item with the same time wins. */
export function byTime<T extends { time: number }>(items: readonly T[]): Map<number, T> {
  return new Map(items.map((item) => [item.time, item] as const));
}

/** A "YYYY-MM-DD" Denver calendar day, as from `denverDayKey`. */
export type DayKey = string;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC noon of a day key's date, or undefined when it isn't a real "YYYY-MM-DD" date. */
function utcNoon(key: string): number | undefined {
  const match = DAY_KEY.exec(key);
  if (match === null) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d, 12);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return undefined;
  }
  return ms;
}

/** `utcNoon`, throwing when `key` isn't a day key. */
function dayKeyNoon(key: DayKey): number {
  const noon = utcNoon(key);
  if (noon === undefined) throw new Error(`not a day key: ${key}`);
  return noon;
}

/** True for a real calendar date written as "YYYY-MM-DD". */
export function isDayKey(key: string): boolean {
  return utcNoon(key) !== undefined;
}

/** The day key `days` calendar days after `key` (calendar arithmetic, so DST never shifts it). */
export function addDays(key: DayKey, days: number): DayKey {
  return new Date(dayKeyNoon(key) + days * 24 * HOUR_MS).toISOString().slice(0, 10);
}

/** The Monday of the Denver week (ISO, Monday start) containing ms, as a day key. */
export function denverWeekKey(ms: number): DayKey {
  const key = denverDayKey(ms);
  const sinceMonday = (new Date(dayKeyNoon(key)).getUTCDay() + 6) % 7;
  return addDays(key, -sinceMonday);
}

/** The Denver calendar month containing ms, as "YYYY-MM". */
export function denverMonthKey(ms: number): string {
  return denverDayKey(ms).slice(0, 7);
}

const dayLabelFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** "Tue, Nov 10" for a day key. */
export function formatDayKey(key: DayKey): string {
  return dayLabelFormat.format(dayKeyNoon(key));
}

const longDayLabelFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

/** "Monday, November 16, 2026" for a day key. */
export function formatLongDayKey(key: DayKey): string {
  return longDayLabelFormat.format(dayKeyNoon(key));
}
