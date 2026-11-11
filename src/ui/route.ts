import { isModelName } from "../core/scoring/hourEvaluator";
import type { ModelName } from "../core/scoring/hourEvaluator";
import type { Site, SiteKind } from "../core/sites/site";
import { isDayKey } from "../core/time";
import type { DayKey } from "../core/time";

/**
 * `day` is undefined for the default day (today, or tomorrow after sunset). `model` is undefined
 * when the hash names no (valid) forecast model. A list has a `mode`, the kind of site it lists;
 * a site's page has none, because the site's own kind decides how it is scored and shown.
 */
export type Route =
  | { page: "list"; mode: SiteKind; day?: DayKey | undefined; model?: ModelName | undefined }
  | { page: "site"; id: string; day?: DayKey | undefined; model?: ModelName | undefined };

/** The model the hash's query names, or undefined when it names none or an unknown one. */
function queryModel(query: string): ModelName | undefined {
  const value = new URLSearchParams(query).get("model");
  return isModelName(value) ? value : undefined;
}

/**
 * `#/` is the Fly list and `#/site/<encoded id>` a site, for the default day. `#/day/YYYY-MM-DD`
 * and `#/day/YYYY-MM-DD/site/<encoded id>` are the same for that day. `#/kite` and
 * `#/kite/YYYY-MM-DD` are the Kite list, for the default day and for that day. Any of them can end
 * in `?model=ecmwf|rrfs`. Anything else (an invalid date included) is the default day's list, in
 * Fly mode unless the path starts `#/kite/`. The model is read from the query whatever the path
 * is, so a bad path keeps the link's model.
 */
export function parseRoute(hash: string): Route {
  const queryStart = hash.indexOf("?");
  const path = parsePath(queryStart === -1 ? hash : hash.slice(0, queryStart));
  const model = queryModel(queryStart === -1 ? "" : hash.slice(queryStart + 1));
  return model === undefined ? path : { ...path, model };
}

/** The `mode` list for `day`, the default day when undefined. */
function list(mode: SiteKind, day?: DayKey): Route {
  return day === undefined ? { page: "list", mode } : { page: "list", mode, day };
}

/** The page, mode and day from the part of the hash before any `?`. */
function parsePath(path: string): Route {
  const kite = /^#\/kite(?:\/([^/]*)\/?)?$/.exec(path);
  if (kite !== null) {
    const dayText = kite[1];
    return list("kiting", dayText !== undefined && isDayKey(dayText) ? dayText : undefined);
  }
  const match = /^#\/(?:day\/([^/]+)\/?)?(?:site\/(.+))?$/.exec(path);
  if (match === null) return list("flying");
  const [, dayText, idText] = match;
  if (dayText !== undefined && !isDayKey(dayText)) return list("flying");
  const day = dayText;
  if (idText === undefined) return list("flying", day);
  try {
    const id = decodeURIComponent(idText);
    return day === undefined ? { page: "site", id } : { page: "site", id, day };
  } catch {
    return list("flying");
  }
}

/** The hash of the `mode` list for `day` (the default day when undefined). */
export function listHref(model: ModelName, mode: SiteKind, day?: DayKey): string {
  const path =
    mode === "kiting"
      ? day === undefined ? "#/kite" : `#/kite/${day}`
      : day === undefined ? "#/" : `#/day/${day}`;
  return `${path}?model=${model}`;
}

export function siteHref(id: string, model: ModelName, day?: DayKey): string {
  const site = `site/${encodeURIComponent(id)}`;
  return `${day === undefined ? `#/${site}` : `#/day/${day}/${site}`}?model=${model}`;
}

/** The hash for the same page, mode and day as `route`, with `model` in place of the route's own. */
export function routeHref(route: Route, model: ModelName): string {
  return route.page === "site"
    ? siteHref(route.id, model, route.day)
    : listHref(model, route.mode, route.day);
}

/**
 * The kind of site the page is about: a list's own mode, or on a site's page that site's kind from
 * `catalog`. Fly for an id the catalog doesn't have, and until the catalog is read (undefined).
 */
export function activeMode(route: Route, catalog: readonly Site[] | undefined): SiteKind {
  if (route.page === "list") return route.mode;
  return catalog?.find((site) => site.id === route.id)?.kind ?? "flying";
}

/** A route that names its model, as the app uses it once the hash is canonical. */
export type CanonicalRoute = Route & { model: ModelName };

/**
 * The route for `hash`, with `defaultModel` when the hash names no valid model, and the hash to
 * rewrite the URL to when `hash` isn't canonical: a missing or bad model gets `defaultModel`, and
 * unknown parameters and a non-canonical path are dropped. It takes no store: only the model control
 * writes the saved default, so a link someone shares can't change it.
 */
export function resolveRoute(
  hash: string,
  defaultModel: ModelName,
): { route: CanonicalRoute; rewrite?: string } {
  const parsed = parseRoute(hash);
  const route: CanonicalRoute = { ...parsed, model: parsed.model ?? defaultModel };
  const canonical = routeHref(route, route.model);
  return canonical === hash ? { route } : { route, rewrite: canonical };
}
