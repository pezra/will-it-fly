import { reasonRank } from "../scoring/hourEvaluator";
import type { ReasonKind, Severity } from "../scoring/hourEvaluator";
import { distanceM } from "../sites/coordinate";
import type { Coordinate, Site } from "../sites/site";
import type {
  BestWindow,
  LaunchEvaluation,
  MainReason,
  RecommendationResult,
  SiteCall,
  SiteRecommendation,
} from "./types";

/** The launch with the highest window score. Ties go to the launch listed first. */
export function bestWindow(launches: readonly LaunchEvaluation[]): BestWindow | undefined {
  let best: BestWindow | undefined;
  for (const l of launches) {
    if (l.window !== undefined && (best === undefined || l.window.score > best.window.score)) {
      best = { launch: l.launch, window: l.window };
    }
  }
  return best;
}

/** The most frequent reason kind of the given severity across the hours, or undefined if none. */
function mostFrequent(
  launches: readonly LaunchEvaluation[],
  severity: Severity,
): MainReason | undefined {
  const counts = new Map<ReasonKind, { count: number; text: string }>();
  for (const l of launches) {
    for (const row of l.daylight) {
      for (const r of row.ecmwf.reasons) {
        if (r.severity !== severity) continue;
        const entry = counts.get(r.kind);
        if (entry === undefined) counts.set(r.kind, { count: 1, text: r.text });
        else entry.count += 1;
      }
    }
  }
  let winner: { kind: ReasonKind; count: number; text: string } | undefined;
  for (const [kind, { count, text }] of counts) {
    const wins =
      winner === undefined ||
      count > winner.count ||
      (count === winner.count && reasonRank(kind) < reasonRank(winner.kind));
    if (wins) winner = { kind, count, text };
  }
  return winner === undefined ? undefined : { kind: winner.kind, severity, text: winner.text };
}

/**
 * Why a site has no window: the most frequent no-go kind across every launch's daylight hours, else
 * the most frequent caution kind, else "no good hour". Count ties go to `REASON_KIND_ORDER`.
 * The text is the first occurrence's.
 */
export function mainReason(launches: readonly LaunchEvaluation[]): MainReason {
  return (
    mostFrequent(launches, "noGo") ??
    mostFrequent(launches, "caution") ?? {
      kind: "noGoodHour",
      severity: "info",
      text: "no good hour",
    }
  );
}

/** Distance from the user to the site's first launch. */
function siteDistanceM(site: Site, location: Coordinate | undefined): number | undefined {
  const first = site.launches[0];
  return location === undefined || first === undefined
    ? undefined
    : distanceM(location, first.coordinate);
}

/** An open site's call. No window: no-go; every hour of the best window good: good; else flyable. */
function openSiteCall(best: BestWindow | undefined): SiteCall {
  if (best === undefined) return "noGo";
  return best.window.hours.every((h) => h.call === "good") ? "good" : "flyable";
}

/**
 * Builds a site's recommendation from its evaluated launches. A closed site keeps none of them.
 * Distances are filled in later by `withDistances`.
 */
export function recommendSite(site: Site, launches: LaunchEvaluation[]): SiteRecommendation {
  if (site.status.state === "closed") return { site, call: "closed", launches: [] };
  const best = bestWindow(launches);
  return {
    site,
    call: openSiteCall(best),
    best,
    mainReason: best === undefined ? mainReason(launches) : undefined,
    launches,
  };
}

/** Ascending, with undefined last. */
function compareDistance(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

function group(rec: SiteRecommendation): 0 | 1 | 2 {
  if (rec.call === "closed") return 2;
  return rec.call === "noGo" ? 1 : 0;
}

/**
 * Orders sites: open sites with a window by score (ties by distance), then open sites without one
 * by distance, then closed sites by name. Undefined distance sorts last. Returns a new array.
 */
export function rankSites(recs: readonly SiteRecommendation[]): SiteRecommendation[] {
  return [...recs].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 0) {
      const byScore = (b.best?.window.score ?? 0) - (a.best?.window.score ?? 0);
      return byScore !== 0 ? byScore : compareDistance(a.distanceM, b.distanceM);
    }
    if (ga === 1) return compareDistance(a.distanceM, b.distanceM);
    return a.site.name.localeCompare(b.site.name);
  });
}

/** Fills in distances from a location and re-ranks, without refetching. */
export function withDistances(
  result: RecommendationResult,
  location: Coordinate | undefined,
): RecommendationResult {
  const sites = result.sites.map((rec) => ({ ...rec, distanceM: siteDistanceM(rec.site, location) }));
  return { ...result, sites: rankSites(sites) };
}
