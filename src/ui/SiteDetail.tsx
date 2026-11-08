import type { LaunchEvaluation } from "../core/recommendation/types";
import { windowLabel } from "../core/scoring/windowFinder";
import { effectiveLimits } from "../core/sites/site";
import type { Launch, Site } from "../core/sites/site";
import { CallBadge } from "./CallBadge";
import { ForecastStatus } from "./ForecastStatus";
import { arcsLabel, confidenceLabel, dayLabel, feet, idealLabel, miles } from "./format";
import { HourlyTable } from "./HourlyTable";
import { listHref } from "./route";
import type { DayKey } from "../core/time";
import type { Recommendations } from "./useRecommendations";

function limitsLine(site: Site, launch: Launch): string {
  const l = effectiveLimits(site, launch);
  const parts = [`${l.minMph}–${l.maxMph} mph`];
  if (l.idealMph !== undefined) parts.push(`ideal ${l.idealMph} mph`);
  parts.push(`gust factor ${l.gustFactorMph} mph`);
  return parts.join(", ");
}

function LaunchSection({ site, evaluation }: { site: Site; evaluation: LaunchEvaluation }) {
  const { launch, window } = evaluation;
  return (
    <section class="launch">
      <h3>{launch.name}</h3>
      <dl class="facts">
        <dt>Elevation</dt>
        <dd>{feet(launch.elevationFt)}</dd>
        <dt>Works best</dt>
        <dd>{idealLabel(launch)}</dd>
        <dt>OK</dt>
        <dd>{arcsLabel(launch.directions.ok)}</dd>
        <dt>Wind limits</dt>
        <dd>{limitsLine(site, launch)}</dd>
        <dt>Best window</dt>
        <dd>
          {window === undefined
            ? "none"
            : `${windowLabel(window)}, ${confidenceLabel(window.confidence)}`}
        </dd>
      </dl>
      <HourlyTable evaluation={evaluation} />
    </section>
  );
}

/** `day` is the route's day, undefined for the default day. */
export function SiteDetail({
  siteId,
  day,
  recs,
}: {
  siteId: string;
  day: DayKey | undefined;
  recs: Recommendations;
}) {
  const { state, location } = recs;
  const back = <a class="back" href={listHref(day)}>← All sites</a>;

  if (state.status !== "loaded") {
    return (
      <>
        {back}
        <ForecastStatus state={state} retry={recs.retry} />
      </>
    );
  }

  const rec = state.result.sites.find((r) => r.site.id === siteId);
  if (rec === undefined) {
    return (
      <>
        {back}
        <p class="status">No site with that id.</p>
      </>
    );
  }

  const { site, best } = rec;
  const distance = location === "found" ? miles(rec.distanceM) : undefined;
  const closedReason = site.status.state === "closed" ? site.status.reason : undefined;
  return (
    <>
      {back}
      <h1>{site.name}</h1>
      <p class="detail-head">
        <CallBadge call={rec.call} /> <span>{dayLabel(state.result.day, state.result.today)}</span>
      </p>
      <dl class="facts">
        <dt>Rating</dt>
        <dd>{site.rating}</dd>
        {distance !== undefined && (
          <>
            <dt>Distance</dt>
            <dd>{distance}</dd>
          </>
        )}
        {best !== undefined && (
          <>
            <dt>Best window</dt>
            <dd>
              <strong>{windowLabel(best.window)}</strong> at {best.launch.name},{" "}
              {confidenceLabel(best.window.confidence)}
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          <a href={site.sourceURL} rel="noopener noreferrer">RMHPA page</a>
        </dd>
      </dl>
      {closedReason !== undefined && <p class="banner">Closed: {closedReason}</p>}
      {closedReason === undefined && state.result.dayOver && (
        <p class="banner">Today's sunset has passed.</p>
      )}
      {closedReason === undefined &&
        !state.result.dayOver &&
        best === undefined &&
        rec.mainReason !== undefined && (
        <p class="banner">No flyable window: {rec.mainReason.text}</p>
      )}
      {site.notes !== undefined && (
        <details class="notes">
          <summary>Site notes</summary>
          <p>{site.notes}</p>
        </details>
      )}
      {site.soaring !== undefined && (
        <p class="notes">
          <strong>Soaring.</strong> {site.soaring.notes}
        </p>
      )}
      {site.xc !== undefined && (
        <p class="notes">
          <strong>XC.</strong> {site.xc.notes}
        </p>
      )}
      {rec.launches.map((evaluation) => (
        <LaunchSection key={evaluation.launch.id} site={site} evaluation={evaluation} />
      ))}
      {closedReason !== undefined && site.launches.length > 0 && (
        <section class="launch">
          <h3>Launches</h3>
          <ul>
            {site.launches.map((l) => (
              <li key={l.id}>
                {l.name}, {feet(l.elevationFt)}, ideal {idealLabel(l)}
              </li>
            ))}
          </ul>
          <p class="note">No forecast is fetched for closed sites.</p>
        </section>
      )}
    </>
  );
}
