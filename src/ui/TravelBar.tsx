import { useEffect, useState } from "preact/hooks";
import { MODEL_LABEL, MODEL_NAMES, isModelName } from "../core/scoring/hourEvaluator";
import type { ModelName } from "../core/scoring/hourEvaluator";
import { SITE_KINDS, isSiteKind } from "../core/sites/site";
import type { SiteKind } from "../core/sites/site";
import type { DayKey } from "../core/time";
import { radiusOptionLabel, startIdentity } from "./format";
import { listHref } from "./route";
import { RADIUS_CHOICES, radiusMinutes } from "./travelSettings";
import { placeStart } from "./useTravel";
import type { Travel } from "./useTravel";
import { driveEventName, modeEventName, trackEvent } from "./usage";

const MODE_LABEL: Readonly<Record<SiteKind, string>> = { flying: "Fly", kiting: "Kite" };

/**
 * The controls for mode, drive limit and forecast model, as selects. The drive-time select's last
 * option, "Change start…", opens the start panel (search box, results, "Use my location", privacy
 * note), which is always open while there is no start. The panel remembers which start it was
 * opened for, so any change of start closes it with no effect, as in DayTitle. `routeDay` is the
 * route's day (undefined on the default day), which a mode change keeps. `model` is the route's
 * model and `setModel` switches it.
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
  const noStart = travel.effectiveStart === undefined;
  const [openFor, setOpenFor] = useState<string | undefined>(undefined);
  const open = noStart || openFor === startIdentity(settings.start);
  const radius = radiusMinutes(settings, travel.mode);
  const searching = searchState.status === "searching";

  return (
    <section class="travel" aria-label="Mode, drive time, start point and forecast model">
      <div class="travel-selects">
        <select
          aria-label="Mode"
          value={travel.mode}
          onChange={(event) => {
            const kind = event.currentTarget.value;
            if (isSiteKind(kind)) {
              trackEvent(modeEventName(kind));
              window.location.hash = listHref(model, kind, routeDay);
            }
          }}
        >
          {SITE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{MODE_LABEL[kind]}</option>
          ))}
        </select>
        <select
          aria-label="Drive time"
          value={String(radius)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "start") {
              // The value prop doesn't change, so Preact won't reset the select; do it here.
              event.currentTarget.value = String(radius);
              setOpenFor(startIdentity(settings.start));
            } else {
              trackEvent(driveEventName(travel.mode, Number(value)));
              travel.setRadius(Number(value));
            }
          }}
        >
          {RADIUS_CHOICES[travel.mode].map((choice) => (
            <option key={choice} value={String(choice)}>
              {radiusOptionLabel(choice, settings.start, travel.effectiveStart)}
            </option>
          ))}
          <option value="start">Change start…</option>
        </select>
        <select
          aria-label="Forecast model"
          value={model}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (isModelName(value)) {
              trackEvent(`model/${value}`);
              setModel(value);
            }
          }}
        >
          {MODEL_NAMES.map((choice) => (
            <option key={choice} value={choice}>{MODEL_LABEL[choice]}</option>
          ))}
        </select>
      </div>
      {open && (
        <div class="travel-start" id="travel-start">
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
                      trackEvent("start/search");
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
          {!noStart && (
            <button type="button" onClick={() => setOpenFor(undefined)}>Done</button>
          )}
        </div>
      )}
    </section>
  );
}
