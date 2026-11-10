import { isModelName } from "../core/scoring/hourEvaluator";
import type { ModelName } from "../core/scoring/hourEvaluator";
import { isDayKey } from "../core/time";
import type { DayKey } from "../core/time";

/**
 * `day` is undefined for the default day (today, or tomorrow after sunset). `model` is undefined
 * when the hash names no (valid) forecast model.
 */
export type Route =
  | { page: "list"; day?: DayKey | undefined; model?: ModelName | undefined }
  | { page: "site"; id: string; day?: DayKey | undefined; model?: ModelName | undefined };

/** The model the hash's query names, or undefined when it names none or an unknown one. */
function queryModel(query: string): ModelName | undefined {
  const value = new URLSearchParams(query).get("model");
  return isModelName(value) ? value : undefined;
}

/**
 * `#/` is the list and `#/site/<encoded id>` a site, for the default day. `#/day/YYYY-MM-DD` and
 * `#/day/YYYY-MM-DD/site/<encoded id>` are the same for that day. Any of them can end in
 * `?model=ecmwf|rrfs`. Anything else (an invalid date included) is the default day's list. The
 * model is read from the query whatever the path is, so a bad path keeps the link's model.
 */
export function parseRoute(hash: string): Route {
  const queryStart = hash.indexOf("?");
  const path = parsePath(queryStart === -1 ? hash : hash.slice(0, queryStart));
  const model = queryModel(queryStart === -1 ? "" : hash.slice(queryStart + 1));
  return model === undefined ? path : { ...path, model };
}

/** The page and day from the part of the hash before any `?`. */
function parsePath(path: string): Route {
  const match = /^#\/(?:day\/([^/]+)\/?)?(?:site\/(.+))?$/.exec(path);
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

export function listHref(model: ModelName, day?: DayKey): string {
  return `${day === undefined ? "#/" : `#/day/${day}`}?model=${model}`;
}

export function siteHref(id: string, model: ModelName, day?: DayKey): string {
  const site = `site/${encodeURIComponent(id)}`;
  return `${day === undefined ? `#/${site}` : `#/day/${day}/${site}`}?model=${model}`;
}

/** The hash for the same page and day as `route`, with `model` in place of the route's own. */
export function routeHref(route: Route, model: ModelName): string {
  return route.page === "site"
    ? siteHref(route.id, model, route.day)
    : listHref(model, route.day);
}

/**
 * The hash `hash` should be rewritten to, or undefined when it is already canonical. A hash that
 * names no valid model gets `defaultModel`; unknown parameters and a non-canonical path are
 * dropped. It takes no store: only the model control writes the saved default, so a link someone
 * shares can't change it.
 */
export function canonicalHash(hash: string, defaultModel: ModelName): string | undefined {
  return resolveRoute(hash, defaultModel).rewrite;
}

/** A route that names its model, as the app uses it once the hash is canonical. */
export type CanonicalRoute = Route & { model: ModelName };

/**
 * The route for `hash`, with `defaultModel` when the hash names no valid model, and the hash to
 * rewrite the URL to when `hash` isn't canonical (see `canonicalHash`).
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
