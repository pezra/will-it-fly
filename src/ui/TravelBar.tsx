import { useEffect, useState } from "preact/hooks";
import { MODEL_LABEL, MODEL_NAMES, isModelName } from "../core/scoring/hourEvaluator";
import type { ModelName } from "../core/scoring/hourEvaluator";
import { SITE_KINDS } from "../core/sites/site";
import type { SiteKind } from "../core/sites/site";
import type { DayKey } from "../core/time";
import { listHref } from "./route";
import { RADIUS_CHOICES, radiusLabel, radiusMinutes } from "./travelSettings";
import { placeStart } from "./useTravel";
import type { Travel } from "./useTravel";

const MODE_LABEL: Readonly<Record<SiteKind, string>> = { flying: "Fly", kiting: "Kite" };

/**
 * The controls for mode, drive limit and forecast model, as selects, and the start point's search
 * box, always shown. `routeDay` is the route's day (undefined on the default day), which a mode
 * change keeps. `model` is the route's model and `setModel` switches it.
 */
export function TravelBar({
  travel,
  model,
  setModel,
  routeDay,
}: {
  travel: Travel;
  model: ModelName;
  setModel: (model: ModelName) => void;
  routeDay: DayKey | undefined;
}) {
  const { settings, searchState } = travel;
  // The box shows the chosen place's name, and follows the start when it changes.
  const startText = settings.start.kind === "place" ? settings.start.name : "";
  const [query, setQuery] = useState(startText);
  useEffect(() => setQuery(startText), [startText]);
  const searching = searchState.status === "searching";

  return (
    <section class="travel" aria-label="Mode, drive time, start point and forecast model">
      <div class="travel-selects">
        <select
          aria-label="Mode"
          value={travel.mode}
          onChange={(event) => {
            const kind = SITE_KINDS.find((k) => k === event.currentTarget.value);
            if (kind !== undefined) window.location.hash = listHref(model, kind, routeDay);
          }}
        >
          {SITE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{MODE_LABEL[kind]}</option>
          ))}
        </select>
        <select
          aria-label="Drive time"
          value={String(radiusMinutes(settings, travel.mode))}
          onChange={(event) => travel.setRadius(Number(event.currentTarget.value))}
        >
          {RADIUS_CHOICES[travel.mode].map((choice) => (
            <option key={choice} value={String(choice)}>{radiusLabel(choice)}</option>
          ))}
        </select>
        <select
          aria-label="Forecast model"
          value={model}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (isModelName(value)) setModel(value);
          }}
        >
          {MODEL_NAMES.map((choice) => (
            <option key={choice} value={choice}>{MODEL_LABEL[choice]}</option>
          ))}
        </select>
      </div>
      <form
        class="travel-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (query !== startText) travel.search(query);
        }}
      >
        <input
          type="search"
          aria-label="Search for a starting place"
          placeholder={settings.start.kind === "geolocation" && travel.effectiveStart !== undefined ? "Your location" : "Search for a place"}
          autocomplete="off"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button type="submit" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>
      {searchState.status === "results" && (
        <ul class="travel-results">
          {searchState.places.map((place) => (
            <li key={`${place.name}|${place.coordinate.latitude}|${place.coordinate.longitude}`}>
              <button
                type="button"
                onClick={() => {
                  const start = placeStart(place);
                  if (start.kind === "place") setQuery(start.name);
                  travel.setPlace(place);
                }}
              >
                {place.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {searchState.status === "none" && (
        <p class="note" role="status">No places found.</p>
      )}
      {searchState.status === "error" && (
        <p class="note" role="status">Search failed: {searchState.message}</p>
      )}
      {settings.start.kind === "place" && (
        <div>
          <button type="button" disabled={travel.locating} onClick={() => travel.useMyLocation()}>
            {travel.locating ? "Locating…" : "Use my location"}
          </button>
          {travel.locationError !== undefined && (
            <p class="note" role="status">{travel.locationError}</p>
          )}
        </div>
      )}
      <p class="note">
        Your start point, rounded to about 1 km, goes to OpenStreetMap's routing service; what
        you type in search goes to Nominatim.
      </p>
    </section>
  );
}
