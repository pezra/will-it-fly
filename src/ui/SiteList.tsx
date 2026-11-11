import type { Recommendations } from "./useRecommendations";
import type { Travel } from "./useTravel";
import type { ModelName } from "../core/scoring/hourEvaluator";
import { SITE_KINDS } from "../core/sites/site";
import type { SiteKind } from "../core/sites/site";
import { missingSiteIds } from "../core/travel/inRange";
import { addDays, denverDayKey } from "../core/time";
import type { DayKey } from "../core/time";
import { DayPicker } from "./DayPicker";
import { ForecastStatus } from "./ForecastStatus";
import { dayLabel, fallbackLine, forecastAge, hiddenLine, loadingMoreLine, stageMessage } from "./format";
import { listHref } from "./route";
import { radiusLabel, radiusMinutes } from "./travelSettings";
import { SiteRow } from "./SiteRow";
import { TravelBar } from "./TravelBar";

function LocationNote({ location }: { location: Recommendations["location"] }) {
  if (location === "denied") {
    return (
      <p class="note">
        Location is off, so distances are hidden. To turn it on: Settings → Safari → Location.
      </p>
    );
  }
  if (location === "unavailable") {
    return <p class="note">Couldn't get your location, so distances are hidden.</p>;
  }
  return null;
}

const MODE_LABEL: Readonly<Record<SiteKind, string>> = { flying: "Fly", kiting: "Kite" };

/** Links to the same day and model in each mode. The mode on screen is the current page. */
function ModeToggle({ mode, day, model }: { mode: SiteKind; day: DayKey | undefined; model: ModelName }) {
  return (
    <nav class="mode-toggle" aria-label="Mode">
      {SITE_KINDS.map((kind) => (
        <a
          key={kind}
          class="mode-link"
          href={listHref(model, kind, day)}
          aria-current={kind === mode ? "page" : undefined}
        >
          {MODE_LABEL[kind]}
        </a>
      ))}
    </nav>
  );
}

/**
 * `day` is the route's day, undefined for the default day; `model` is the route's model, kept by
 * every link, and `setModel` switches it. Lists `travel.shown`, the sites of `travel.mode`.
 */
export function SiteList({
  travel,
  day,
  model,
  setModel,
}: {
  travel: Travel;
  day: DayKey | undefined;
  model: ModelName;
  setModel: (model: ModelName) => void;
}) {
  const { state, location, now, refresh, retry } = travel.recs;

  // With no start, a loaded result can only be a site page's own site, so it is not the list.
  const noStart = travel.stage === "needsStart" || travel.stage === "locating";
  if (state.status !== "loaded" || noStart) {
    const message = stageMessage(travel.stage);
    return (
      <>
        <h1>Will it fly?</h1>
        {/* Keyed like the loaded view's, so the link a switch was made from keeps its focus. */}
        <ModeToggle key="mode" mode={travel.mode} day={day} model={model} />
        <DayPicker today={denverDayKey(now())} shown={day} model={model} mode={travel.mode} />
        {/* The travel bar is the only way to set a start when there is none. The same `key` as the
            loaded view's, so a switch that passes through loading doesn't close its options. */}
        <TravelBar
          key="travel"
          travel={travel}
          model={model}
          setModel={setModel}
          openWhen={travel.stage === "needsStart"}
        />
        {state.status === "failed" || (state.status === "loading" && message === undefined) ? (
          <ForecastStatus state={state} retry={retry} />
        ) : (
          <p class="status" role="status">{message}</p>
        )}
        {travel.effectiveStart === undefined && <LocationNote location={location} />}
      </>
    );
  }

  const { result } = state;
  const missing = missingSiteIds(result, travel.inRangeIds).length;
  const fallback = fallbackLine(result.model, travel.shown);
  return (
    <>
      <header class="list-header">
        <h1>{dayLabel(result.day, result.today)}</h1>
        <button type="button" onClick={refresh} disabled={state.refreshing}>
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p class="age">{forecastAge(result.fetchedAt, now())}</p>
      <ModeToggle key="mode" mode={travel.mode} day={day} model={model} />
      <DayPicker today={result.today} shown={result.day} model={model} mode={travel.mode} />
      <TravelBar key="travel" travel={travel} model={model} setModel={setModel} />
      {fallback !== undefined && !result.dayOver && <p class="note">{fallback}</p>}
      {/* Until routing is done and the in-range sites arrive the hidden count is wrong, so it waits. */}
      {travel.stage === "ready" && missing === 0 && travel.hiddenCount > 0 && !result.dayOver && (
        <p class="hidden-line">
          {hiddenLine(travel.hiddenCount, radiusLabel(radiusMinutes(travel.settings, travel.mode)), travel.total)}
        </p>
      )}
      {state.refreshing && missing > 0 && <p class="note">{loadingMoreLine(missing)}</p>}
      {result.isOffline && (
        <p class="banner" role="status">
          Offline: showing the last saved forecast.
        </p>
      )}
      {state.refreshError !== undefined && (
        <p class="banner" role="alert">Refresh failed: {state.refreshError}</p>
      )}
      {result.dayOver ? (
        <p class="banner">
          Today's sunset has passed. <a href={listHref(model, travel.mode, addDays(result.today, 1))}>See tomorrow</a>
        </p>
      ) : (
        <ul class="rows">
          {travel.shown.map((rec) => (
            <SiteRow key={rec.site.id} rec={rec} day={day} model={model} />
          ))}
        </ul>
      )}
    </>
  );
}
