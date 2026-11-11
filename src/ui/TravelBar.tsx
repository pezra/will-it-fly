import { useEffect, useState } from "preact/hooks";
import { MODEL_LABEL, MODEL_NAMES } from "../core/scoring/hourEvaluator";
import type { ModelName } from "../core/scoring/hourEvaluator";
import type { DayKey } from "../core/time";
import { DayPicker } from "./DayPicker";
import { statusLine } from "./format";
import { ModeToggle } from "./ModeToggle";
import { RADIUS_CHOICES, radiusLabel, radiusMinutes } from "./travelSettings";
import type { Travel } from "./useTravel";

const OPTIONS_ID = "travel-options";

/**
 * The one bar for mode, day, start point, drive limit and forecast model: a status line that
 * expands to the controls. `day` is the shown day (the route's while loading, else the result's),
 * `dayText` its label (undefined while the default day isn't known) and `today` anchors the picker.
 * `openWhen` opens them when it turns true (no start yet, so the search is the next step); the user
 * can still close them. `model` is the route's model and `setModel` switches it.
 */
export function TravelBar({
  travel,
  model,
  setModel,
  day,
  today,
  dayText,
  openWhen = false,
}: {
  travel: Travel;
  model: ModelName;
  setModel: (model: ModelName) => void;
  day: DayKey | undefined;
  today: DayKey;
  dayText: string | undefined;
  openWhen?: boolean;
}) {
  const [open, setOpen] = useState(openWhen);
  useEffect(() => {
    if (openWhen) setOpen(true);
  }, [openWhen]);
  const { settings, searchState } = travel;
  // The box shows the chosen place's name, and follows the start when it changes.
  const startText = settings.start.kind === "place" ? settings.start.name : "";
  const [query, setQuery] = useState(startText);
  useEffect(() => setQuery(startText), [startText]);
  const searching = searchState.status === "searching";

  return (
    <section class="travel" aria-label="Mode, day, start point, drive time and forecast model">
      <button
        type="button"
        class="travel-toggle"
        aria-expanded={open}
        aria-controls={OPTIONS_ID}
        onClick={() => setOpen(!open)}
      >
        <span>{statusLine(dayText, settings, travel.effectiveStart, travel.recs.location, model, travel.mode)}</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div id={OPTIONS_ID} class="travel-options">
          <ModeToggle mode={travel.mode} day={day} model={model} />
          <DayPicker today={today} shown={day} model={model} mode={travel.mode} />
          <div class="travel-radius" role="group" aria-label="Drive time">
            {RADIUS_CHOICES[travel.mode].map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={radiusMinutes(settings, travel.mode) === choice}
                onClick={() => travel.setRadius(choice)}
              >
                {radiusLabel(choice)}
              </button>
            ))}
          </div>
          <div class="travel-model" role="group" aria-label="Forecast model">
            {MODEL_NAMES.map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={model === choice}
                onClick={() => setModel(choice)}
              >
                {MODEL_LABEL[choice]}
              </button>
            ))}
          </div>
          <form
            class="travel-search"
            onSubmit={(event) => {
              event.preventDefault();
              travel.search(query);
            }}
          >
            <input
              type="search"
              aria-label="Search for a starting place"
              placeholder={settings.start.kind === "geolocation" ? "Your location" : "Search for a place"}
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
        </div>
      )}
    </section>
  );
}
