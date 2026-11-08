import type { Recommendations } from "./useRecommendations";
import { ForecastStatus } from "./ForecastStatus";
import { dayLabel, forecastAge } from "./format";
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

export function SiteList({ recs }: { recs: Recommendations }) {
  const { state, location, now, refresh, retry } = recs;

  if (state.status !== "loaded") {
    return (
      <>
        <h1>Will it fly?</h1>
        <ForecastStatus state={state} retry={retry} />
      </>
    );
  }

  const { result } = state;
  return (
    <>
      <header class="list-header">
        <h1>{dayLabel(result.day)}</h1>
        <button type="button" onClick={refresh} disabled={state.refreshing}>
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p class="age">{forecastAge(result.fetchedAt, now())}</p>
      {result.isOffline && (
        <p class="banner" role="status">
          Offline: showing the last saved forecast.
        </p>
      )}
      {state.refreshError !== undefined && (
        <p class="banner" role="alert">Refresh failed: {state.refreshError}</p>
      )}
      <LocationNote location={location} />
      <ul class="rows">
        {result.sites.map((rec) => (
          <SiteRow key={rec.site.id} rec={rec} />
        ))}
      </ul>
    </>
  );
}
