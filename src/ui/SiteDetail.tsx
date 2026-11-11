import type { LaunchEvaluation } from "../core/recommendation/types";
import { MODEL_LABEL } from "../core/scoring/hourEvaluator";
import type { ModelName } from "../core/scoring/hourEvaluator";
import { windowLabel } from "../core/scoring/windowFinder";
import { effectiveLimits } from "../core/sites/site";
import type { Launch, Site, SiteKind } from "../core/sites/site";
import { ResultBadge } from "./CallBadge";
import { ForecastStatus } from "./ForecastStatus";
import { arcsLabel, cautionLine, confidenceLabel, dayLabel, driveLabel, feet, idealLabel, launchFallbackNote, miles, siteModel, sourceLabel } from "./format";
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
            : `${windowLabel(window)}, ${confidenceLabel(window.confidence, evaluation.model)}`}
        </dd>
      </dl>
      {evaluation.fellBack && <p class="note">{launchFallbackNote}</p>}
      <HourlyTable evaluation={evaluation} />
    </section>
  );
}

/**
 * `day` is the route's day, undefined for the default day, and `model` its model; the back link
 * keeps both. `mode` is the site's kind (Fly until the catalog is read), and the back link goes
 * to that mode's list. `catalogIds` is undefined until the catalog is read; only an id outside it is
 * "not found".
 */
export function SiteDetail({
  siteId,
  day,
  model,
  mode,
  recs,
  catalogIds,
}: {
  siteId: string;
  day: DayKey | undefined;
  model: ModelName;
  mode: SiteKind;
  recs: Recommendations;
  catalogIds: ReadonlySet<string> | undefined;
}) {
  const { state } = recs;
  const back = <a class="back" href={listHref(model, mode, day)}>← All sites</a>;

  if (catalogIds?.has(siteId) === false) {
    return (
      <>
        {back}
        <p class="status">No site with that id.</p>
      </>
    );
  }

  const rec = state.status === "loaded" ? state.result.sites.find((r) => r.site.id === siteId) : undefined;
  if (state.status !== "loaded" || rec === undefined) {
    // The shown result can be the list's while this site's own load starts or is in flight.
    // Only a failed load with none running shows the failure.
    const failure =
      state.status === "failed"
        ? state.message
        : state.status === "loaded" && !state.refreshing
          ? state.refreshError
          : undefined;
    const status =
      failure === undefined ? { status: "loading" as const } : { status: "failed" as const, message: failure };
    return (
      <>
        {back}
        <ForecastStatus state={status} retry={recs.retry} />
      </>
    );
  }

  const { site, best } = rec;
  const distance = miles(rec.distanceM);
  const cautions = cautionLine(best?.window.cautions ?? []);
  const closedReason = site.status.state === "closed" ? site.status.reason : undefined;
  return (
    <>
      {back}
      <h1>{site.name}</h1>
      <p class="detail-head">
        <ResultBadge call={rec.call} conditions={best?.window.conditions} /> <span>{dayLabel(state.result.day, state.result.today)}</span>
      </p>
      {cautions !== undefined && <p class="row-caution">{cautions}</p>}
      <dl class="facts">
        <dt>Rating</dt>
        <dd>{site.rating}</dd>
        <dt>Forecast model</dt>
        <dd>{MODEL_LABEL[siteModel(rec, state.result.model)]}</dd>
        {rec.driveTime !== undefined && (
          <>
            <dt>Drive time</dt>
            <dd>{driveLabel(rec.driveTime)}</dd>
          </>
        )}
        {distance !== undefined && (
          <>
            <dt>Distance (straight-line)</dt>
            <dd>{distance}</dd>
          </>
        )}
        {best !== undefined && (
          <>
            <dt>Best window</dt>
            <dd>
              <strong>{windowLabel(best.window)}</strong> at {best.launch.name},{" "}
              {confidenceLabel(best.window.confidence, best.model)}
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          <a href={site.sourceURL} rel="noopener noreferrer">{sourceLabel(site.sourceURL)}</a>
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
