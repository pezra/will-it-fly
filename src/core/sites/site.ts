export interface Coordinate {
  latitude: number;
  longitude: number;
}

/** A clockwise arc of compass degrees from `from` to `to`, inclusive. May wrap past 360. */
export interface DegreeArc {
  from: number;
  to: number;
}

export interface DirectionRanges {
  ok: DegreeArc[];
  ideal: DegreeArc[];
}

export interface WindLimits {
  minMph: number;
  idealMph?: number;
  maxMph: number;
  gustFactorMph?: number;
}

export type SiteStatus = { state: "open" } | { state: "closed"; reason: string };

export interface Launch {
  id: string; // "rmhpa/glenwood-lookout/north"
  name: string;
  coordinate: Coordinate;
  elevationFt: number;
  directions: DirectionRanges;
  /** Per-launch override of the site limits. Rarely used. */
  limits?: WindLimits;
}

export interface Site {
  id: string; // "rmhpa/crested-butte"
  name: string;
  sourceURL: string;
  notes?: string;
  rating: string; // "P4"
  status: SiteStatus;
  launches: Launch[];
  limits: WindLimits;
}

/** Used when an RMHPA page lists no PG limits. */
export const DEFAULT_WIND_LIMITS: Readonly<WindLimits> = Object.freeze({
  minMph: 0,
  maxMph: 15,
  gustFactorMph: 5,
});

export function elevationM(launch: Launch): number {
  return launch.elevationFt * 0.3048;
}
