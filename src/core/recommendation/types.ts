import type { ModelHour } from "../forecast/models";
import type { HourResult, ReasonKind, Severity } from "../scoring/hourEvaluator";
import type { TargetDay, FlyingWindow } from "../scoring/windowFinder";
import type { Launch, Site } from "../sites/site";

/**
 * Why a site has no window. Mostly an hour-level reason, but "no good hour" has no `ReasonKind`
 * (and shouldn't: it never appears on an hour), so it is a kind of its own here.
 */
export interface MainReason {
  kind: ReasonKind | "noGoodHour";
  severity: Severity;
  text: string;
}

/** One daylight hour: both models' results (after the storm look-ahead) and forecast hours. */
export interface DaylightRow {
  time: number;
  ecmwf: HourResult;
  ecmwfHour: ModelHour;
  /** Undefined when RRFS has no hour at this time. */
  rrfs?: HourResult | undefined;
  rrfsHour?: ModelHour | undefined;
}

/** One launch's forecast, evaluated for the detail view. */
export interface LaunchEvaluation {
  launch: Launch;
  /** The ECMWF hours inside the target day's daylight (and not yet over), in time order. */
  daylight: DaylightRow[];
  /** The launch's best window for the target day. */
  window?: FlyingWindow | undefined;
}

export interface BestWindow {
  launch: Launch;
  window: FlyingWindow;
}

/** A site's headline call: closed, no-go (no window), good (every window hour good) or flyable. */
export type SiteCall = "closed" | "noGo" | "good" | "flyable";

export interface SiteRecommendation {
  site: Site;
  call: SiteCall;
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
