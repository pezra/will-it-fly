import { normalizedDegrees } from "./sites/degreeArc";

export const METERS_PER_FOOT = 0.3048;
export const METERS_PER_MILE = 1609.344;

const COMPASS_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

/** 16-point compass name for a bearing in degrees. */
export function compass(deg: number): string {
  return COMPASS_16[Math.round(normalizedDegrees(deg) / 22.5) % 16] ?? "N";
}

/** "12 mph". */
export function mph(speed: number): string {
  return `${Math.round(speed)} mph`;
}

/** The largest defined value, or undefined when none is defined. */
export function definedMax(...values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}
