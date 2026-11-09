import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { firstLaunchCoordinate } from "../core/recommendation/ranker";
import type { SiteRecommendation } from "../core/recommendation/types";
import type { Coordinate } from "../core/sites/site";
import { bundledSiteProvider } from "../core/sites/siteProvider";
import { applyTravel } from "../core/travel/applyTravel";
import type { TravelTimes } from "../core/travel/applyTravel";
import { OSRM_TIMEOUT_MS, driveTimesFor, startKey } from "../core/travel/driveTime";
import type { Destination } from "../core/travel/driveTime";
import { GEOCODE_TIMEOUT_MS, searchPlaces, shortPlaceName } from "../core/travel/geocode";
import type { Place } from "../core/travel/geocode";
import type { DebugParams } from "./debugParams";
import { describeError } from "./format";
import { locate } from "./location";
import type { LocationResult } from "./location";
import { localStorageStore } from "./storage";
import { fetchTransportWithTimeout } from "./transport";
import {
  MAX_PLACE_NAME_LENGTH,
  loadTravelSettings,
  maxSeconds,
  saveTravelSettings,
} from "./travelSettings";
import type { MaxHours, TravelSettings, TravelStart } from "./travelSettings";
import type { Recommendations } from "./useRecommendations";

/** A place search: `results` holds at least one place; `none` is an empty answer. */
type SearchState =
  | { status: "idle" }
  | { status: "searching"; query: string }
  | { status: "results"; places: Place[] }
  | { status: "none" }
  | { status: "error"; message: string };

export interface Travel {
  /** The recommendations with distances and drive times from the start. `state` is unfiltered. */
  recs: Recommendations;
  /** The sites within the drive limit, in rank order. Empty until the forecast loads. */
  shown: SiteRecommendation[];
  hiddenCount: number;
  settings: TravelSettings;
  /** The start in use: the chosen place, else the found location, else none (nothing filtered). */
  effectiveStart: Coordinate | undefined;
  setMaxHours: (maxHours: MaxHours) => void;
  /** Starts from `place`, stored under its short name. */
  setPlace: (place: Place) => void;
  /** Re-requests the location and starts from it. On failure the place stays and `locationError` is set. */
  useMyLocation: () => void;
  /** True while `useMyLocation` waits for the location. */
  locating: boolean;
  locationError: string | undefined;
  /**
   * Searches for places. The latest call wins: an earlier search still in flight is dropped. An
   * empty query resets to idle.
   */
  search: (query: string) => void;
  searchState: SearchState;
}

/** The chosen place wins; else the location if it was found; else there is no start. */
export function resolveStart(
  settings: TravelSettings,
  locationResult: LocationResult | undefined,
): Coordinate | undefined {
  if (settings.start.kind === "place") return settings.start.coordinate;
  return locationResult?.status === "found" ? locationResult.coordinate : undefined;
}

/** The stored start for a search result: its short name, else the capped full name, else "Chosen place". */
export function placeStart(place: Place): TravelStart {
  const short = shortPlaceName(place.name);
  const full = short === "" ? place.name.trim() : short;
  const name = (full === "" ? "Chosen place" : full).slice(0, MAX_PLACE_NAME_LENGTH);
  return { kind: "place", name, coordinate: place.coordinate };
}

const routeTransport = fetchTransportWithTimeout(OSRM_TIMEOUT_MS);
const geocodeTransport = fetchTransportWithTimeout(GEOCODE_TIMEOUT_MS);

let destinations: Promise<Destination[]> | undefined;

/** Every site's first launch, from the catalog, so drive times don't wait for the forecast. */
function siteDestinations(): Promise<Destination[]> {
  destinations ??= bundledSiteProvider()
    .sites()
    .then((sites) =>
      sites.flatMap((site) => {
        const coordinate = firstLaunchCoordinate(site);
        return coordinate === undefined ? [] : [{ id: site.id, coordinate }];
      }),
    )
    .catch((error: unknown) => {
      destinations = undefined;
      throw error;
    });
  return destinations;
}

/**
 * Owns the start point, the drive limit and the place search, and applies them to `recs`. Drive
 * times are fetched once per rounded start (never on a radius change); until they arrive every
 * site uses the straight-line estimate. The settings are stored between visits.
 */
export function useTravel(recs: Recommendations, debug: DebugParams): Travel {
  const store = useMemo(() => localStorageStore(), []);
  const [settings, setSettings] = useState<TravelSettings>(() => loadTravelSettings(store));
  const saved = useRef(settings);
  useEffect(() => {
    if (saved.current === settings) return;
    saved.current = settings;
    saveTravelSettings(store, settings);
  }, [settings, store]);

  const { locationResult, relocate } = recs;
  const effectiveStart = useMemo(
    () => resolveStart(settings, locationResult),
    [settings, locationResult],
  );

  // Keyed on the rounded start only, so a radius change or a re-render never refetches.
  const key = effectiveStart === undefined ? undefined : startKey(effectiveStart);
  const startRef = useRef(effectiveStart);
  startRef.current = effectiveStart;
  const [times, setTimes] = useState<TravelTimes | undefined>(undefined);
  const timesRequest = useRef(0);
  useEffect(() => {
    const id = ++timesRequest.current;
    const start = startRef.current;
    if (key === undefined || start === undefined) return;
    const deps = { transport: routeTransport, cache: store, baseURL: debug.routeBaseURL };
    siteDestinations()
      .then((dests) => driveTimesFor(start, dests, deps))
      .then(
        (result) => {
          if (id === timesRequest.current) setTimes({ startKey: key, times: result });
        },
        (error: unknown) => console.warn("Could not load drive times", error),
      );
  }, [key, debug.routeBaseURL, store]);

  const limit = maxSeconds(settings);
  const applied = useMemo(
    () =>
      recs.state.status === "loaded"
        ? applyTravel(recs.state.result, effectiveStart, times, limit)
        : undefined,
    [recs.state, effectiveStart, times, limit],
  );

  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | undefined>(undefined);
  const locateRequest = useRef(0);
  const useMyLocation = useCallback(() => {
    const id = ++locateRequest.current;
    setLocating(true);
    setLocationError(undefined);
    void locate(debug).then((result) => {
      if (id !== locateRequest.current) return;
      setLocating(false);
      if (result.status === "found") {
        relocate(result);
        setSettings((s) => ({ ...s, start: { kind: "geolocation" } }));
      } else {
        setLocationError(
          result.status === "denied" ? "Location is off." : "Couldn't get your location.",
        );
      }
    });
  }, [debug, relocate]);

  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });
  const searchRequest = useRef(0);
  const search = useCallback((query: string) => {
    if (query.trim() === "") {
      ++searchRequest.current;
      setSearchState({ status: "idle" });
      return;
    }
    const id = ++searchRequest.current;
    setSearchState({ status: "searching", query });
    searchPlaces(query, geocodeTransport).then(
      (places) => {
        if (id !== searchRequest.current) return;
        setSearchState(places.length === 0 ? { status: "none" } : { status: "results", places });
      },
      (error: unknown) => {
        if (id !== searchRequest.current) return;
        console.warn("Place search failed", error);
        setSearchState({ status: "error", message: describeError(error) });
      },
    );
  }, []);

  const setPlace = useCallback((place: Place) => {
    ++locateRequest.current;
    ++searchRequest.current;
    setLocating(false);
    setLocationError(undefined);
    setSearchState({ status: "idle" });
    setSettings((s) => ({ ...s, start: placeStart(place) }));
  }, []);

  const setMaxHours = useCallback((maxHours: MaxHours) => {
    setSettings((s) => ({ ...s, maxHours }));
  }, []);

  const state =
    applied !== undefined && recs.state.status === "loaded"
      ? { ...recs.state, result: applied.result }
      : recs.state;
  return {
    recs: { ...recs, state },
    shown: applied?.shown ?? [],
    hiddenCount: applied === undefined ? 0 : applied.result.sites.length - applied.shown.length,
    settings,
    effectiveStart,
    setMaxHours,
    setPlace,
    useMyLocation,
    locating,
    locationError,
    search,
    searchState,
  };
}
