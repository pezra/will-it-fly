export const DENVER = "America/Denver";

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DENVER,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
});

function part(ms: number, type: "year" | "month" | "day" | "hour"): string {
  const found = partsFormat.formatToParts(ms).find((p) => p.type === type);
  if (found === undefined) throw new Error(`Intl returned no ${type} part`);
  return found.value;
}

/** Calendar day in America/Denver, as "YYYY-MM-DD". */
export function denverDayKey(ms: number): string {
  return `${part(ms, "year")}-${part(ms, "month")}-${part(ms, "day")}`;
}

/** Hour of day (0-23) in America/Denver. */
export function denverHour(ms: number): number {
  return Number(part(ms, "hour"));
}

/** "HH:00" for the Denver hour containing ms. */
export function formatDenverTime(ms: number): string {
  return `${String(denverHour(ms)).padStart(2, "0")}:00`;
}

/** One hour in milliseconds. */
export const HOUR_MS = 3_600_000;
