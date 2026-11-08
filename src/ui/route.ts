import { isDayKey } from "../core/time";
import type { DayKey } from "../core/time";

/** `day` is undefined for the default day (today, or tomorrow after sunset). */
export type Route =
  | { page: "list"; day?: DayKey | undefined }
  | { page: "site"; id: string; day?: DayKey | undefined };

/**
 * `#/` is the list and `#/site/<encoded id>` a site, for the default day. `#/day/YYYY-MM-DD` and
 * `#/day/YYYY-MM-DD/site/<encoded id>` are the same for that day. Anything else (an invalid date
 * included) is the default day's list.
 */
export function parseRoute(hash: string): Route {
  const match = /^#\/(?:day\/([^/]+)\/?)?(?:site\/(.+))?$/.exec(hash);
  if (match === null) return { page: "list" };
  const [, dayText, idText] = match;
  if (dayText !== undefined && !isDayKey(dayText)) return { page: "list" };
  const day = dayText;
  if (idText === undefined) return day === undefined ? { page: "list" } : { page: "list", day };
  try {
    const id = decodeURIComponent(idText);
    return day === undefined ? { page: "site", id } : { page: "site", id, day };
  } catch {
    return { page: "list" };
  }
}

export function listHref(day?: DayKey): string {
  return day === undefined ? "#/" : `#/day/${day}`;
}

export function siteHref(id: string, day?: DayKey): string {
  const site = `site/${encodeURIComponent(id)}`;
  return day === undefined ? `#/${site}` : `#/day/${day}/${site}`;
}
