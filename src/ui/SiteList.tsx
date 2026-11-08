import type { Recommendations } from "./useRecommendations";
import { addDays, denverDayKey } from "../core/time";
import type { DayKey } from "../core/time";
import { DayPicker } from "./DayPicker";
import { ForecastStatus } from "./ForecastStatus";
import { dayLabel, forecastAge } from "./format";
import { listHref } from "./route";
import { SiteRow } from "./SiteRow";

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

/** `day` is the route's day, undefined for the default day. */
export function SiteList({ recs, day }: { recs: Recommendations; day: DayKey | undefined }) {
  const { state, location, now, refresh, retry } = recs;

  if (state.status !== "loaded") {
    return (
      <>
        <h1>Will it fly?</h1>
        <DayPicker today={denverDayKey(now())} shown={day} />
        <ForecastStatus state={state} retry={retry} />
      </>
    );
  }

  const { result } = state;
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
      {result.isOffline && (
        <p class="banner" role="status">
          Offline: showing the last saved forecast.
        </p>
      )}
      {state.refreshError !== undefined && (
        <p class="banner" role="alert">Refresh failed: {state.refreshError}</p>
      )}
      <LocationNote location={location} />
      {result.dayOver ? (
        <p class="banner">
          Today's sunset has passed. <a href={listHref(addDays(result.today, 1))}>See tomorrow</a>
        </p>
      ) : (
        <ul class="rows">
          {result.sites.map((rec) => (
            <SiteRow key={rec.site.id} rec={rec} day={day} />
          ))}
        </ul>
      )}
    </>
  );
}
