import type { SiteRecommendation } from "../core/recommendation/types";
import { windowLabel } from "../core/scoring/windowFinder";
import type { DayKey } from "../core/time";
import { ResultBadge } from "./CallBadge";
import { siteHref } from "./route";
import { cautionLine, confidenceLabel, driveLabel, miles } from "./format";

/** `day` is the route's day (undefined for the default), so the detail link keeps it. */
export function SiteRow({ rec, day }: { rec: SiteRecommendation; day: DayKey | undefined }) {
  const { site, best } = rec;
  const miLabel = miles(rec.distanceM);
  const distance =
    rec.driveTime === undefined
      ? miLabel
      : miLabel === undefined
        ? driveLabel(rec.driveTime)
        : `${driveLabel(rec.driveTime)} · ${miLabel}`;
  const status = site.status;
  const note =
    status.state === "closed"
      ? status.reason
      : best === undefined
        ? rec.mainReason?.text
        : undefined;
  const cautions = cautionLine(best?.window.cautions ?? []);
  const highGusts = best?.window.warnings.some((r) => r.kind === "highGusts") ?? false;

  return (
    <li>
      <a class="row" href={siteHref(site.id, day)}>
        <div class="row-top">
          <span class="row-name">{site.name}</span>
          <ResultBadge call={rec.call} conditions={best?.window.conditions} />
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
        {cautions !== undefined && <div class="row-note row-caution">{cautions}</div>}
        {highGusts && <div class="row-note row-warning">⚠ high gusts possible</div>}
      </a>
    </li>
  );
}
