import type { Recommendations } from "./useRecommendations";
import type { Travel } from "./useTravel";
import { addDays, denverDayKey } from "../core/time";
import type { DayKey } from "../core/time";
import { DayPicker } from "./DayPicker";
import { ForecastStatus } from "./ForecastStatus";
import { dayLabel, forecastAge, hiddenLine, loadingMoreLine, stageMessage } from "./format";
import { listHref } from "./route";
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

/** `day` is the route's day, undefined for the default day. Lists `travel.shown`. */
export function SiteList({ travel, day }: { travel: Travel; day: DayKey | undefined }) {
  const { state, location, now, refresh, retry } = travel.recs;

  // With no start, a loaded result can only be a site page's own site, so it is not the list.
  const noStart = travel.stage === "needsStart" || travel.stage === "locating";
  if (state.status !== "loaded" || noStart) {
    const message = stageMessage(travel.stage);
    return (
      <>
        <h1>Will it fly?</h1>
        <DayPicker today={denverDayKey(now())} shown={day} />
        {/* The travel bar is the only way to set a start when there is none. */}
        <TravelBar travel={travel} openWhen={travel.stage === "needsStart"} />
        {state.status !== "loaded" && (state.status === "failed" || message === undefined) ? (
          <ForecastStatus state={state} retry={retry} />
        ) : (
          <p class="status" role="status">{message}</p>
        )}
        {travel.effectiveStart === undefined && <LocationNote location={location} />}
      </>
    );
  }

  const { result } = state;
  const have = new Set(result.sites.map((r) => r.site.id));
  const missing = travel.inRangeIds.filter((id) => !have.has(id)).length;
  return (
    <>
      <header class="list-header">
        <h1>{dayLabel(result.day, result.today)}</h1>
        <button type="button" onClick={refresh} disabled={state.refreshing}>
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p class="age">{forecastAge(result.fetchedAt, now())}</p>
      <DayPicker today={result.today} shown={result.day} />
      <TravelBar travel={travel} />
      {/* Until the in-range sites arrive the hidden count is too high, so it waits. */}
      {missing === 0 && travel.hiddenCount > 0 && !result.dayOver && (
        <p class="hidden-line">
          {hiddenLine(travel.hiddenCount, travel.settings.maxHours, travel.catalogSize)}
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
      {travel.effectiveStart === undefined && <LocationNote location={location} />}
      {result.dayOver ? (
        <p class="banner">
          Today's sunset has passed. <a href={listHref(addDays(result.today, 1))}>See tomorrow</a>
        </p>
      ) : (
        <ul class="rows">
          {travel.shown.map((rec) => (
            <SiteRow key={rec.site.id} rec={rec} day={day} />
          ))}
        </ul>
      )}
    </>
  );
}
