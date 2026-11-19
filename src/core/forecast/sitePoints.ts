import type { Coordinate, Launch } from "../sites/site";

/** A launch this far or less below its site's highest launch uses the highest launch's point. */
export const SHARED_POINT_MAX_DROP_FT = 1000;

export interface ForecastPoint {
  coordinate: Coordinate;
  elevationFt: number;
}

export interface SitePoints {
  /** Point 0 is the site's highest launch. The neighbor ring centers on its coordinate. */
  points: [ForecastPoint, ...ForecastPoint[]];
  /** `pointOf[i]` is the index in `points` of launch `i`. */
  pointOf: number[];
}

/**
 * The forecast points a site needs, and which one each launch uses. Elevation is the one input
 * that varies a forecast between a site's launches, and within 1,000 ft the difference is small,
 * so launches share the highest launch's point. A launch farther below gets its own point.
 */
export function sitePoints(launches: readonly Launch[]): SitePoints {
  const first = launches[0];
  if (first === undefined) throw new Error("sitePoints needs at least one launch");
  let anchor = first;
  for (const l of launches) if (l.elevationFt > anchor.elevationFt) anchor = l;

  const points: SitePoints["points"] = [{ coordinate: anchor.coordinate, elevationFt: anchor.elevationFt }];
  const pointOf = launches.map((l) => {
    if (anchor.elevationFt - l.elevationFt <= SHARED_POINT_MAX_DROP_FT) return 0;
    const same = points.findIndex(
      (p, i) =>
        i > 0 &&
        p.elevationFt === l.elevationFt &&
        p.coordinate.latitude === l.coordinate.latitude &&
        p.coordinate.longitude === l.coordinate.longitude,
    );
    if (same >= 0) return same;
    points.push({ coordinate: l.coordinate, elevationFt: l.elevationFt });
    return points.length - 1;
  });
  return { points, pointOf };
}
