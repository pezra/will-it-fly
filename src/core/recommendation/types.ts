import type { ModelHour } from "../forecast/models";
import type { HourResult, ModelName, ReasonKind, Severity } from "../scoring/hourEvaluator";
import type { FlyingWindow } from "../scoring/windowFinder";
import type { Launch, Site } from "../sites/site";
import type { DayKey } from "../time";
import type { DriveTime } from "../travel/driveTime";

/**
 * Why a site has no window. Mostly an hour-level reason, but "no flyable hour" has no `ReasonKind`
 * (and shouldn't: it never appears on an hour), so it is a kind of its own here.
 */
export interface MainReason {
  kind: ReasonKind | "noFlyableHour";
  severity: Severity;
  text: string;
}

/** One model's result for an hour (after the storm look-ahead) and the forecast hour it came from. */
export interface ModelRow {
  result: HourResult;
  hour: ModelHour;
}

/**
 * One daylight hour, by role: the primary model and the check model. Which model each is comes
 * from `LaunchEvaluation.model`.
 */
export interface DaylightRow {
  time: number;
  primary: ModelRow;
  /** Undefined when the check model has no hour at this time. */
  check?: ModelRow | undefined;
}

/** One launch's forecast, evaluated for the detail view. */
export interface LaunchEvaluation {
  launch: Launch;
  /** The primary model this launch was evaluated with. */
  model: ModelName;
  /** True when RRFS was asked for but doesn't cover the day, so the launch uses ECMWF. */
  fellBack: boolean;
  /** The primary model's hours inside the day's daylight (and not yet over), in time order. */
  daylight: DaylightRow[];
  /** The launch's best window for the day. */
  window?: FlyingWindow | undefined;
}

export interface BestWindow {
  launch: Launch;
  /** The launch's primary model. */
  model: ModelName;
  window: FlyingWindow;
}

/** A site's headline call: closed, no-go (no window), good (every window hour good) or flyable. */
export type SiteCall = "closed" | "noGo" | "good" | "flyable";

export interface SiteRecommendation {
  site: Site;
  call: SiteCall;
  /** Great-circle distance from the user to the site's first launch. */
  distanceM?: number | undefined;
  /** Drive time from the start to the site's first launch, set by `applyTravel`. */
  driveTime?: DriveTime | undefined;
  /** The best launch's best window. Undefined when no launch has one, and for closed sites. */
  best?: BestWindow | undefined;
  /** Set for open sites without a window. */
  mainReason?: MainReason | undefined;
  /** Empty for closed sites. */
  launches: LaunchEvaluation[];
}

export interface RecommendationResult {
  /** The requested primary model. A launch may still fall back to ECMWF (`LaunchEvaluation.fellBack`). */
  model: ModelName;
  /** The day the sites are evaluated for. */
  day: DayKey;
  /** Today's day key (by the clock the result was computed with). */
  today: DayKey;
  /** True when `day` is today and today's sunset has passed, so no hour is left to fly. */
  dayOver: boolean;
  /** When the forecast was fetched (epoch ms). */
  fetchedAt: number;
  /** True when a fetch failed and the cached forecast was used. */
  isOffline: boolean;
  sites: SiteRecommendation[];
}
