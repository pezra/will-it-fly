import { METERS_PER_FOOT } from "../units";

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
  /** With `idealMph`, the ideal is the range `idealMph`–`idealMaxMph`. */
  idealMaxMph?: number;
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

/** The source says the site offers ridge soaring. Its notes quote or summarize what it says. */
export interface SiteSoaring {
  notes: string;
  /** Overrides `ridgeLiftMinMph` for this site. */
  minMph?: number;
  /** Only these launches soar. Absent means every launch. */
  launchIds?: string[];
}

/** The source says the site has cross-country potential. */
export interface SiteXC {
  notes: string;
}

/** A guide the sites are curated from. Its id is the first part of its sites' ids. */
export interface SiteSource {
  id: string; // "rmhpa"
  name: string;
  url: string;
}

export const SITE_KINDS = ["flying", "kiting"] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

export interface Site {
  id: string; // "rmhpa/crested-butte"
  name: string;
  /** Kiting sites are scored with the kiting rules and listed only in Kite mode. */
  kind: SiteKind;
  sourceURL: string;
  notes?: string;
  soaring?: SiteSoaring;
  xc?: SiteXC;
  rating?: string; // "P4"; kiting sites have none
  status: SiteStatus;
  launches: Launch[];
  limits: WindLimits;
}

/** Limits with every default filled in. */
export type EffectiveLimits = WindLimits & { gustFactorMph: number };

/** Used when a site's source lists no PG limits. */
export const DEFAULT_WIND_LIMITS: Readonly<EffectiveLimits> = Object.freeze({
  minMph: 0,
  maxMph: 15,
  gustFactorMph: 5,
});

/**
 * The limits that apply at a launch: launch limits override the site limits as a whole, and a
 * missing gust factor falls back to `DEFAULT_WIND_LIMITS`.
 */
export function effectiveLimits(site: Site, launch: Launch): EffectiveLimits {
  const limits = launch.limits ?? site.limits;
  return { ...limits, gustFactorMph: limits.gustFactorMph ?? DEFAULT_WIND_LIMITS.gustFactorMph };
}

export function elevationM(launch: Launch): number {
  return launch.elevationFt * METERS_PER_FOOT;
}
