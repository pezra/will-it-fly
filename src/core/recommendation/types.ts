import type { ModelHour } from "../forecast/models";
import type { HourResult, ReasonKind, Severity } from "../scoring/hourEvaluator";
import type { TargetDay, FlyingWindow } from "../scoring/windowFinder";
import type { Launch, Site } from "../sites/site";

/**
 * Why a site has no window. Mostly an hour-level reason, but "no flyable hour" has no `ReasonKind`
 * (and shouldn't: it never appears on an hour), so it is a kind of its own here.
 */
export interface MainReason {
  kind: ReasonKind | "noFlyableHour";
  severity: Severity;
  text: string;
}

/** One launch's forecast, evaluated for the detail view. */
export interface LaunchEvaluation {
  launch: Launch;
  /** Every ECMWF and RRFS hour in the response, as parsed. */
  ecmwfHours: ModelHour[];
  rrfsHours: ModelHour[];
  /** Hourly results after the storm look-ahead, in time order. Not limited to daylight. */
  ecmwf: HourResult[];
  rrfs: HourResult[];
  /** The ECMWF results inside the target day's daylight (and not yet over), in time order. */
  daylight: HourResult[];
  /** The launch's best window for the target day. */
  window?: FlyingWindow | undefined;
}

export interface BestWindow {
  launch: Launch;
  window: FlyingWindow;
}

export interface SiteRecommendation {
  site: Site;
  /** Great-circle distance from the user to the site's first launch. */
  distanceM?: number | undefined;
  /** The best launch's best window. Undefined when no launch has one, and for closed sites. */
  best?: BestWindow | undefined;
  /** Set for open sites without a window. */
  mainReason?: MainReason | undefined;
  /** Empty for closed sites. */
  launches: LaunchEvaluation[];
}

export interface RecommendationResult {
  day: TargetDay;
  /** When the forecast was fetched (epoch ms). */
  fetchedAt: number;
  /** True when a fetch failed and the cached forecast was used. */
  isOffline: boolean;
  sites: SiteRecommendation[];
}
