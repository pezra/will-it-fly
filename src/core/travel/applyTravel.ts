import { firstLaunchCoordinate, withDistances } from "../recommendation/ranker";
import type { RecommendationResult, SiteRecommendation } from "../recommendation/types";
import type { Coordinate } from "../sites/site";
import { estimateDriveSeconds, startKey } from "./driveTime";
import type { DriveTime } from "./driveTime";

/** Drive times fetched for one start. They apply only while `startKey` matches the start in use. */
export interface TravelTimes {
  startKey: string;
  times: ReadonlyMap<string, DriveTime>;
}

/**
 * Annotates every site with its distance and drive time from `start`, then hides the sites over
 * `maxSeconds`. `result` is the full annotated result (a hidden site stays in it); `shown` is what
 * the list displays. A routed time is used only when `times` was fetched for this start; otherwise
 * the straight-line estimate from the unrounded start. A site with no launch is never hidden. With
 * no `start` nothing is annotated or hidden. Does not change its inputs.
 */
export function applyTravel(
  result: RecommendationResult,
  start: Coordinate | undefined,
  times: TravelTimes | undefined,
  maxSeconds: number,
): { result: RecommendationResult; shown: SiteRecommendation[] } {
  if (start === undefined) return { result, shown: [...result.sites] };

  const key = startKey(start);
  const routed = times?.startKey === key ? times.times : undefined;
  const annotated = withDistances(result, start);
  const sites = annotated.sites.map((rec): SiteRecommendation => {
    const first = firstLaunchCoordinate(rec.site);
    if (first === undefined) return rec;
    const driveTime: DriveTime = routed?.get(rec.site.id) ?? {
      seconds: estimateDriveSeconds(start, first),
      source: "estimate",
    };
    return { ...rec, driveTime };
  });
  const shown = sites.filter((rec) => rec.driveTime === undefined || rec.driveTime.seconds <= maxSeconds);
  return { result: { ...annotated, sites }, shown };
}
