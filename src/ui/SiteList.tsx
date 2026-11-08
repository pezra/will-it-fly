import type { Recommendations } from "./useRecommendations";
import { forecastAge } from "./format";
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

  if (state.status === "loading") {
    return (
      <>
        <h1>Flyable sites</h1>
        <p class="status" role="status">Loading forecast…</p>
      </>
    );
  }

  if (state.status === "failed") {
    return (
      <>
        <h1>Flyable sites</h1>
        <div class="error" role="alert">
          <p><strong>Couldn't load the forecast.</strong></p>
          <p>{state.message}</p>
          <button type="button" onClick={retry}>Retry</button>
        </div>
      </>
    );
  }

  const { result } = state;
  return (
    <>
      <header class="list-header">
        <h1>{result.day === "today" ? "Today" : "Tomorrow"}</h1>
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
