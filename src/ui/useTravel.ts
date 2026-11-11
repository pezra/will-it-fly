import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SiteRecommendation } from "../core/recommendation/types";
import type { Coordinate, Site, SiteKind } from "../core/sites/site";
import { MINUTES_PER_HOUR } from "../core/units";
import { applyTravel } from "../core/travel/applyTravel";
import type { TravelTimes } from "../core/travel/applyTravel";
import { OSRM_TIMEOUT_MS, driveTimesFor, startKey, withinReach } from "../core/travel/driveTime";
import type { DriveTime } from "../core/travel/driveTime";
import { inRangeIds, mergeTimes, missingDestinations, travelStage } from "../core/travel/inRange";
import type { TravelStage } from "../core/travel/inRange";
import { GEOCODE_TIMEOUT_MS, searchPlaces, shortPlaceName } from "../core/travel/geocode";
import type { Place } from "../core/travel/geocode";
import type { DebugParams } from "./debugParams";
import { describeError } from "./format";
import { locate } from "./location";
import type { LocationResult, LocationStatus } from "./location";
import { localStorageStore } from "./storage";
import { fetchTransportWithTimeout } from "./transport";
import {
  MAX_PLACE_NAME_LENGTH,
  loadTravelSettings,
  maxSeconds,
  radiusMinutes,
  saveTravelSettings,
  withRadius,
} from "./travelSettings";
import type { TravelSettings, TravelStart } from "./travelSettings";
import type { ForecastLoad, Recommendations } from "./useRecommendations";

/** A place search: `results` holds at least one place; `none` is an empty answer. */
type SearchState =
  | { status: "idle" }
  | { status: "searching"; query: string }
  | { status: "results"; places: Place[] }
  | { status: "none" }
  | { status: "error"; message: string };

/** What `useTravel` returns: the start, the drive limit and which sites are in range. */
export interface TravelPipeline {
  settings: TravelSettings;
  /** The mode the pipeline serves: the kind of site it routes, and whose radius is the drive limit. */
  mode: SiteKind;
  /** The start in use: the chosen place, else the found location, else none (nothing loads until one is set). */
  effectiveStart: Coordinate | undefined;
  /** The drive times fetched so far for the current start (routed or estimated). */
  times: TravelTimes | undefined;
  /** The catalog `useTravel` was given, undefined until it is read. */
  catalog: readonly Site[] | undefined;
  stage: TravelStage;
  /** The sites within the drive limit, in catalog order. Meaningful once `stage` is ready. */
  inRangeIds: readonly string[];
  location: LocationStatus;
  /** The geolocation answer, undefined while pending. */
  locationResult: LocationResult | undefined;
  /**
   * Replaces the location after the user asks for it again. A load-time answer that arrives
   * later is ignored.
   */
  relocate: (result: LocationResult) => void;
  /** Sets the drive limit, in minutes. A value that isn't one of the mode's choices is ignored. */
  setRadius: (minutes: number) => void;
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

/** The travel pipeline applied to the loaded forecast, as the list and the travel bar use it. */
export interface Travel extends TravelPipeline {
  /** The recommendations with distances and drive times from the start. `state` is unfiltered. */
  recs: Recommendations;
  /** The sites within the drive limit, in rank order. Empty until the forecast loads. */
  shown: SiteRecommendation[];
  /** The mode's catalog sites not shown, 0 without a start or a loaded forecast. */
  hiddenCount: number;
  /** How many catalog sites are of the mode's kind, 0 until the catalog is read. */
  total: number;
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

/**
 * The sites to route for the `mode` list: the catalog's sites of that kind `withinReach` of `start`
 * at the mode's radius, in catalog order.
 */
export function travelCandidates(
  sites: readonly Site[],
  mode: SiteKind,
  start: Coordinate,
  settings: TravelSettings,
): Site[] {
  return withinReach(
    sites.filter((site) => site.kind === mode),
    start,
    radiusMinutes(settings, mode) / MINUTES_PER_HOUR,
  );
}

/** The start the empty list offers, so someone with no start or no site in range can see it work. */
export const EXAMPLE_PLACE: Place = {
  name: "Boulder, Colorado",
  coordinate: { latitude: 40.015, longitude: -105.27 },
};

/**
 * Whether the list offers `EXAMPLE_PLACE`: with no start, or once the forecast has loaded with no
 * site in range. `missing` is the in-range sites whose weather hasn't arrived; `shownCount` the
 * sites listed.
 */
export function offersExample({
  stage,
  loaded,
  missing,
  shownCount,
}: {
  stage: TravelStage;
  loaded: boolean;
  missing: number;
  shownCount: number;
}): boolean {
  if (stage === "needsStart") return true;
  return loaded && stage === "ready" && missing === 0 && shownCount === 0;
}

/** What the `mode` list shows of the in-range sites, and what its hidden line counts. */
export interface ListView {
  /** The in-range sites of the mode's kind, in the order given (rank order). */
  shown: SiteRecommendation[];
  /** The mode's sites not shown, 0 without a start. */
  hiddenCount: number;
  /** How many sites of the mode's kind the catalog has. */
  total: number;
}

/**
 * The `mode` list's view of `shown`, the sites `applyTravel` kept: only the mode's kind, counted
 * against the catalog `sites` of that kind. Without a start nothing is hidden.
 */
export function listView(
  shown: readonly SiteRecommendation[],
  mode: SiteKind,
  sites: readonly Site[],
  hasStart: boolean,
): ListView {
  const ofKind = shown.filter((rec) => rec.site.kind === mode);
  const total = sites.filter((site) => site.kind === mode).length;
  return { shown: ofKind, hiddenCount: hasStart ? total - ofKind.length : 0, total };
}

const routeTransport = fetchTransportWithTimeout(OSRM_TIMEOUT_MS);
const geocodeTransport = fetchTransportWithTimeout(GEOCODE_TIMEOUT_MS);

const NO_TIMES: ReadonlyMap<string, DriveTime> = new Map();

/**
 * Owns everything before the weather: the location, the start point, the drive limit, the place
 * search and the drive times. The candidates are the `catalog` sites of the `mode`'s kind
 * `withinReach` of the start at the mode's radius; OSRM is asked only for candidates the current
 * start has no time for yet, so narrowing the limit or switching back asks nothing and widening
 * or switching to a new mode asks only for the new sites. The settings are stored between visits.
 */
export function useTravel(
  debug: DebugParams,
  catalog: readonly Site[] | undefined,
  mode: SiteKind,
): TravelPipeline {
  const store = useMemo(() => localStorageStore(), []);
  const [settings, setSettings] = useState<TravelSettings>(() => loadTravelSettings(store));
  const saved = useRef(settings);
  useEffect(() => {
    if (saved.current === settings) return;
    saved.current = settings;
    saveTravelSettings(store, settings);
  }, [settings, store]);

  const [locationResult, setLocationResult] = useState<LocationResult | undefined>(undefined);
  const relocated = useRef(false);
  const relocate = useCallback((result: LocationResult) => {
    relocated.current = true;
    setLocationResult(result);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void locate(debug).then((r) => {
      if (!cancelled && !relocated.current) setLocationResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [debug.noLocation, debug.location]);

  const effectiveStart = useMemo(
    () => resolveStart(settings, locationResult),
    [settings, locationResult],
  );
  const key = effectiveStart === undefined ? undefined : startKey(effectiveStart);
  // Keyed on the mode's own radius, so the other mode's radius changing recomputes nothing.
  const modeMinutes = radiusMinutes(settings, mode);
  const candidates = useMemo(
    () =>
      catalog === undefined || effectiveStart === undefined
        ? undefined
        : travelCandidates(catalog, mode, effectiveStart, settings),
    [catalog, effectiveStart, mode, modeMinutes],
  );
  // Ids in catalog order, so the same candidates always give the same string.
  const candidateKey = candidates?.map((s) => s.id).join("\n");

  const [times, setTimes] = useState<TravelTimes | undefined>(undefined);
  // Read by the drive-time effect, which runs only when the start or the candidates change.
  const startRef = useRef(effectiveStart);
  startRef.current = effectiveStart;
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const timesRef = useRef(times);
  timesRef.current = times;
  // A response is kept only if it is for the start now in use. Merging into the same start is
  // always safe, so a response a mode switch left behind still counts; `mergeTimes` replaces the
  // map of another start.
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    const start = startRef.current;
    const wanted = candidatesRef.current;
    if (key === undefined || start === undefined || wanted === undefined) return;
    const missing = missingDestinations(wanted, timesRef.current, key);
    if (missing.length === 0) {
      // Nothing to ask, but a new start (with no candidates, say) still needs its own map.
      setTimes((prev) => mergeTimes(prev, key, NO_TIMES));
      return;
    }
    const deps = { transport: routeTransport, cache: store, baseURL: debug.routeBaseURL };
    driveTimesFor(start, missing, deps).then(
      (result) => {
        if (key === keyRef.current) setTimes((prev) => mergeTimes(prev, key, result));
      },
      (error: unknown) => console.warn("Could not load drive times", error),
    );
  }, [key, candidateKey, debug.routeBaseURL, store]);

  const limit = maxSeconds(settings, mode);
  const stage = travelStage({
    start: effectiveStart,
    locationPending: locationResult === undefined,
    candidates,
    times,
  });
  const inRange = useMemo(
    () =>
      candidates === undefined || key === undefined || times?.startKey !== key
        ? []
        : inRangeIds(candidates, times.times, limit),
    [candidates, key, times, limit],
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

  const setRadius = useCallback((minutes: number) => {
    setSettings((s) => withRadius(s, mode, minutes));
  }, [mode]);

  return {
    settings,
    mode,
    effectiveStart,
    times,
    catalog,
    stage,
    inRangeIds: inRange,
    location: locationResult?.status ?? "pending",
    locationResult,
    relocate,
    setRadius,
    setPlace,
    useMyLocation,
    locating,
    locationError,
    search,
    searchState,
  };
}

/**
 * Applies the start and the drive limit to the loaded forecast: distances and drive times on every
 * site, and `shown`, the ones within the limit. A site loaded for its own page that is not a
 * candidate gets the straight-line estimate, which is always over the limit, so it stays hidden.
 */
export function useTravelView(travel: TravelPipeline, recs: ForecastLoad): Travel {
  const { effectiveStart, times, settings, mode, catalog, location, locationResult, relocate } = travel;
  const limit = maxSeconds(settings, mode);
  const applied = useMemo(
    () =>
      recs.state.status === "loaded"
        ? applyTravel(recs.state.result, effectiveStart, times, limit)
        : undefined,
    [recs.state, effectiveStart, times, limit],
  );

  const state =
    applied !== undefined && recs.state.status === "loaded"
      ? { ...recs.state, result: applied.result }
      : recs.state;
  const { shown, hiddenCount, total } = useMemo(
    () =>
      listView(
        applied?.shown ?? [],
        mode,
        catalog ?? [],
        applied !== undefined && effectiveStart !== undefined && catalog !== undefined,
      ),
    [applied, mode, catalog, effectiveStart],
  );
  return {
    ...travel,
    recs: { ...recs, state, location, locationResult, relocate },
    shown,
    hiddenCount,
    total,
  };
}
