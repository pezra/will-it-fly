import { firstLaunchCoordinate } from "../recommendation/ranker";
import type { RecommendationResult } from "../recommendation/types";
import type { Coordinate, Site } from "../sites/site";
import type { DayKey } from "../time";
import type { TravelTimes } from "./applyTravel";
import { startKey } from "./driveTime";
import type { Destination, DriveTime } from "./driveTime";

/**
 * Where the list is before weather can load: no start yet (`needsStart`), waiting for the location
 * (`locating`), waiting for drive times (`routing`), or every candidate has one (`ready`).
 */
export type TravelStage = "needsStart" | "locating" | "routing" | "ready";

/** Each site's first launch, the point its drive is timed to. A site with no launch has none. */
export function routeDestinations(sites: readonly Site[]): Destination[] {
  return sites.flatMap((site) => {
    const coordinate = firstLaunchCoordinate(site);
    return coordinate === undefined ? [] : [{ id: site.id, coordinate }];
  });
}

/** The times `times` holds for the start `key`, if it was fetched for that start. */
function timesFor(times: TravelTimes | undefined, key: string): ReadonlyMap<string, DriveTime> | undefined {
  return times?.startKey === key ? times.times : undefined;
}

/** The candidates' destinations that `times` has no time for from the start `key`. */
export function missingDestinations(
  candidates: readonly Site[],
  times: TravelTimes | undefined,
  key: string,
): Destination[] {
  const known = timesFor(times, key);
  return routeDestinations(candidates).filter((d) => known?.has(d.id) !== true);
}

/**
 * `fetched` added to the times for the start `key`. Times for another start are replaced, not
 * merged. Returns `times` itself when nothing changes. Does not change its inputs.
 */
export function mergeTimes(
  times: TravelTimes | undefined,
  key: string,
  fetched: ReadonlyMap<string, DriveTime>,
): TravelTimes {
  const known = timesFor(times, key);
  if (known !== undefined && times !== undefined && fetched.size === 0) return times;
  return { startKey: key, times: new Map([...(known ?? []), ...fetched]) };
}

/**
 * The ids of the candidates within `maxSeconds`, in candidate order. A candidate with no time in
 * `times` is not in range; a site with no launch always is (it is never hidden, as in `applyTravel`).
 */
export function inRangeIds(
  candidates: readonly Site[],
  times: ReadonlyMap<string, DriveTime>,
  maxSeconds: number,
): string[] {
  return candidates
    .filter((site) => {
      if (firstLaunchCoordinate(site) === undefined) return true;
      const time = times.get(site.id);
      return time !== undefined && time.seconds <= maxSeconds;
    })
    .map((site) => site.id);
}

/**
 * The stage for a start. `candidates` is undefined until the catalog is loaded. Ready means `times`
 * was fetched for this start and has a time for every candidate with a launch.
 */
export function travelStage({
  start,
  locationPending,
  candidates,
  times,
}: {
  start: Coordinate | undefined;
  locationPending: boolean;
  candidates: readonly Site[] | undefined;
  times: TravelTimes | undefined;
}): TravelStage {
  if (start === undefined) return locationPending ? "locating" : "needsStart";
  if (candidates === undefined) return "routing";
  const known = timesFor(times, startKey(start));
  if (known === undefined) return "routing";
  return routeDestinations(candidates).every((d) => known.has(d.id)) ? "ready" : "routing";
}

/**
 * The sites to load weather for. A site page wants its own site at once, whatever the stage; the
 * list wants the in-range sites once the stage is ready, and nothing (undefined) before that.
 */
export function wantedSiteIds({
  page,
  routeSiteId,
  stage,
  inRangeIds,
}: {
  page: "list" | "site";
  routeSiteId: string | undefined;
  stage: TravelStage;
  inRangeIds: readonly string[];
}): readonly string[] | undefined {
  if (page === "site") return routeSiteId === undefined ? undefined : [routeSiteId];
  return stage === "ready" ? inRangeIds : undefined;
}

/** Keys a weather load: the day and the ids, in any order. */
export function weatherLoadKey(day: DayKey | undefined, ids: readonly string[]): string {
  return JSON.stringify([day ?? null, [...ids].sort()]);
}

/** The `ids` that `result` has no site for. */
export function missingSiteIds(result: RecommendationResult, ids: readonly string[]): string[] {
  const have = new Set(result.sites.map((r) => r.site.id));
  return ids.filter((id) => !have.has(id));
}

/** True when `result` already has every one of `ids`, so loading them again would add nothing. */
export function containsSites(result: RecommendationResult, ids: readonly string[]): boolean {
  return missingSiteIds(result, ids).length === 0;
}
