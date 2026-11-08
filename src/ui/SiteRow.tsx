import type { SiteRecommendation } from "../core/recommendation/types";
import { windowLabel } from "../core/scoring/windowFinder";
import { CallBadge } from "./CallBadge";
import type { BadgeCall } from "./CallBadge";
import { siteHref } from "./route";
import { confidenceLabel, miles } from "./format";

/** The site's headline call: closed, no-go, or flyable (every hour flyable) / marginal. */
export function siteCall(rec: SiteRecommendation): BadgeCall {
  if (rec.site.status.state === "closed") return "closed";
  if (rec.best === undefined) return "noGo";
  return rec.best.window.hours.every((h) => h.call === "flyable") ? "flyable" : "marginal";
}

export function SiteRow({ rec }: { rec: SiteRecommendation }) {
  const { site, best } = rec;
  const distance = miles(rec.distanceM);
  const status = site.status;
  const note =
    status.state === "closed"
      ? status.reason
      : best === undefined
        ? rec.mainReason?.text
        : undefined;
  const highGusts = best?.window.hours.some((h) => h.reasons.some((r) => r.kind === "highGusts")) ?? false;

  return (
    <li>
      <a class="row" href={siteHref(site.id)}>
        <div class="row-top">
          <span class="row-name">{site.name}</span>
          <CallBadge call={siteCall(rec)} />
        </div>
        <div class="row-meta">
          <span>{site.rating}</span>
          {distance !== undefined && <span>{distance}</span>}
          {best !== undefined && (
            <>
              <strong class="window">{windowLabel(best.window)}</strong>
              <span>{confidenceLabel(best.window.confidence)}</span>
              {site.launches.length > 1 && <span>{best.launch.name}</span>}
            </>
          )}
        </div>
        {note !== undefined && <div class="row-note">{note}</div>}
        {highGusts && <div class="row-note row-warning">⚠ high gusts possible</div>}
      </a>
    </li>
  );
}
