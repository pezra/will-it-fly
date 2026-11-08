import type { LaunchEvaluation } from "../core/recommendation/types";
import { windowLabel } from "../core/scoring/windowFinder";
import type { Launch, Site } from "../core/sites/site";
import { CallBadge } from "./CallBadge";
import { arcsLabel, confidenceLabel, feet, miles } from "./format";
import { HourlyTable } from "./HourlyTable";
import { siteCall } from "./SiteRow";
import type { Recommendations } from "./useRecommendations";

function limitsLine(site: Site, launch: Launch): string {
  const l = launch.limits ?? site.limits;
  const parts = [`${l.minMph}–${l.maxMph} mph`];
  if (l.idealMph !== undefined) parts.push(`ideal ${l.idealMph} mph`);
  if (l.gustFactorMph !== undefined) parts.push(`gust factor ${l.gustFactorMph} mph`);
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
        <dd>{arcsLabel(launch.directions.ideal)}</dd>
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

export function SiteDetail({ siteId, recs }: { siteId: string; recs: Recommendations }) {
  const { state, location } = recs;
  const back = <a class="back" href="#/">← All sites</a>;

  if (state.status === "loading") {
    return (
      <>
        {back}
        <p class="status" role="status">Loading forecast…</p>
      </>
    );
  }
  if (state.status === "failed") {
    return (
      <>
        {back}
        <div class="error" role="alert">
          <p><strong>Couldn't load the forecast.</strong></p>
          <p>{state.message}</p>
          <button type="button" onClick={recs.retry}>Retry</button>
        </div>
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
        <CallBadge call={siteCall(rec)} /> <span>{state.result.day === "today" ? "Today" : "Tomorrow"}</span>
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
      {closedReason === undefined && best === undefined && rec.mainReason !== undefined && (
        <p class="banner">No flyable window: {rec.mainReason.text}</p>
      )}
      {site.notes !== undefined && (
        <details class="notes">
          <summary>Site notes</summary>
          <p>{site.notes}</p>
        </details>
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
                {l.name}, {feet(l.elevationFt)}, ideal {arcsLabel(l.directions.ideal)}
              </li>
            ))}
          </ul>
          <p class="note">No forecast is fetched for closed sites.</p>
        </section>
      )}
    </>
  );
}
