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
