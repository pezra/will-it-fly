import { isRecord } from "./isRecord";
import { tryParseJSON } from "./json";
import type { KeyValueStore } from "./keyValueStore";
import { denverDayKey, denverMonthKey, denverWeekKey } from "./time";

/** A calendar period (Denver time, ISO weeks starting Monday) a device is counted active in once. */
export type Period = "day" | "week" | "month";

/** One GoatCounter hit: a page view, or a named event. */
export type Hit =
  | { kind: "pageview"; path: string; referrer?: string | undefined; screen?: string | undefined }
  | { kind: "event"; name: string; screen?: string | undefined };

/**
 * The GoatCounter count URL for `hit`. `rnd` is a cache-buster; empty `r` and `s` are left out.
 * Hand-joined with `encodeURIComponent`: core has no `URLSearchParams`.
 */
export function countURL(base: string, hit: Hit, rnd: string): string {
  const params: [string, string][] = [["p", hit.kind === "pageview" ? hit.path : hit.name]];
  if (hit.kind === "event") params.push(["e", "true"]);
  if (hit.kind === "pageview" && hit.referrer) params.push(["r", hit.referrer]);
  if (hit.screen) params.push(["s", hit.screen]);
  params.push(["rnd", rnd]);
  return `${base}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

/** The storage key for the last day, week and month this device was counted active. */
export const USAGE_KEY = "willItFly.usage.v1";

const PERIODS: readonly Period[] = ["day", "week", "month"];

/**
 * The periods (day, week, month, in that order) that `now` is the first open of on this device.
 * When any is new, records the current keys for all three. A store that can't be written is logged
 * and ignored, so the periods are still reported.
 */
export function newPeriods(store: KeyValueStore, now: number): Period[] {
  const current: Record<Period, string> = {
    day: denverDayKey(now),
    week: denverWeekKey(now),
    month: denverMonthKey(now),
  };

  const raw = store.get(USAGE_KEY);
  const parsed = raw === undefined ? undefined : tryParseJSON(raw);
  const last = parsed?.ok === true && isRecord(parsed.value) ? parsed.value : {};

  const fresh = PERIODS.filter((period) => last[period] !== current[period]);
  if (fresh.length > 0) {
    try {
      store.set(USAGE_KEY, JSON.stringify(current));
    } catch (error) {
      console.warn("Could not save the usage markers", error);
    }
  }
  return fresh;
}
