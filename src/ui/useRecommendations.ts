import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createSiteForecastCache } from "../core/forecast/siteForecastCache";
import { getRecommendations } from "../core/recommendation/recommendationService";
import type { RecommendationResult } from "../core/recommendation/types";
import type { ModelName } from "../core/scoring/hourEvaluator";
import type { SiteKind } from "../core/sites/site";
import { bundledSiteProvider } from "../core/sites/siteProvider";
import { containsSites, weatherLoadKey } from "../core/travel/inRange";
import type { DayKey } from "../core/time";
import type { DebugParams } from "./debugParams";
import { describeError } from "./format";
import type { LocationResult, LocationStatus } from "./location";
import { localStorageStore } from "./storage";
import { fetchTransport } from "./transport";

export type RecommendationsState =
  | { status: "loading" }
  | {
      status: "loaded";
      /** The day that was asked for (undefined for the default day). */
      requested: DayKey | undefined;
      /** The list's mode that was asked for, undefined for a site page's own load. */
      mode: SiteKind | undefined;
      result: RecommendationResult;
      /** True while a Refresh is in flight. */
      refreshing: boolean;
      /** Set when a Refresh failed and the previous result is still shown. */
      refreshError?: string;
    }
  | { status: "failed"; message: string };

/** What `useRecommendations` returns: the weather load, before travel adds the location. */
export interface ForecastLoad {
  state: RecommendationsState;
  /** The clock the UI should use for ages (the debug `now` when set). */
  now: () => number;
  /** A forced reload of the same sites. */
  refresh: () => void;
  retry: () => void;
}

/** The load with the location from `useTravel`, as the pages use it. */
export interface Recommendations extends ForecastLoad {
  location: LocationStatus;
  /** The geolocation answer, undefined while pending. */
  locationResult: LocationResult | undefined;
  /**
   * Replaces the location after the user asks for it again. A load-time answer that arrives
   * later is ignored.
   */
  relocate: (result: LocationResult) => void;
}

/** How often the forecast age re-renders while the page is visible. */
const TICK_MS = 60_000;

/** The latest load, while it is in flight. */
export interface PendingLoad {
  day: DayKey | undefined;
  model: ModelName;
  /** The list's mode, undefined for a site page's own load. */
  mode: SiteKind | undefined;
  ids: readonly string[];
}

/**
 * True when a load for the mode `loadedMode` will do for `mode`. A list takes only its own mode's
 * load. A site page (undefined `mode`) takes any, so going from a list to one of its sites doesn't
 * reload; whether the result has the site is up to the caller.
 */
function modeServes(loadedMode: SiteKind | undefined, mode: SiteKind | undefined): boolean {
  return mode === undefined || loadedMode === mode;
}

/** `state` when it is a result loaded for `day` with `model` as the primary model, for `mode`. */
function loadedFor(
  state: RecommendationsState,
  day: DayKey | undefined,
  model: ModelName,
  mode: SiteKind | undefined,
): Extract<RecommendationsState, { status: "loaded" }> | undefined {
  if (state.status !== "loaded") return undefined;
  return state.requested === day && state.result.model === model && modeServes(state.mode, mode)
    ? state
    : undefined;
}

/**
 * What the reload effect does for `ids` on `day` with `model` and `mode` (the list's, undefined on
 * a site page), given the state `prev` and the load in flight `pending`:
 * - `"load"` when there are ids and `prev` has no result for this day, model and mode, or one
 *   without some of the ids.
 * - `"keep"` when nothing needs loading and the load in flight is for this day, model and mode and
 *   covers the ids, so it may still land.
 * - `"drop"` otherwise (undefined ids included): any load in flight is dropped, so it can't
 *   replace what is on screen later (a site page's single site over the list, say).
 */
export function loadDecision(
  prev: RecommendationsState,
  day: DayKey | undefined,
  model: ModelName,
  mode: SiteKind | undefined,
  ids: readonly string[] | undefined,
  pending: PendingLoad | undefined,
): "load" | "keep" | "drop" {
  if (ids === undefined) return "drop";
  const loaded = loadedFor(prev, day, model, mode);
  if (loaded === undefined || !containsSites(loaded.result, ids)) return "load";
  const covering =
    pending !== undefined &&
    pending.day === day &&
    pending.model === model &&
    modeServes(pending.mode, mode) &&
    ids.every((id) => pending.ids.includes(id));
  return covering ? "keep" : "drop";
}

/**
 * The state after a load is dropped. A failure from the dropped load must not sit over the next
 * stage, and a result for another day, model or mode must not stay on screen (as during
 * `routing`, when the ids are undefined), so both give loading. The result for this day, model and
 * mode stays, with no refresh in flight.
 */
export function droppedState(
  prev: RecommendationsState,
  day: DayKey | undefined,
  model: ModelName,
  mode: SiteKind | undefined,
): RecommendationsState {
  if (prev.status === "failed") return { status: "loading" };
  if (prev.status !== "loaded") return prev;
  const loaded = loadedFor(prev, day, model, mode);
  if (loaded === undefined) return { status: "loading" };
  const { refreshError: _dropped, ...rest } = loaded;
  return { ...rest, refreshing: false };
}

/**
 * The state shown while a load for `day` with `model` and `mode` is in flight: the result for this
 * day, model and mode, refreshing (it keeps the mode it was loaded for), or loading. Another day's,
 * model's or mode's result is never shown as this one's.
 */
export function pendingState(
  prev: RecommendationsState,
  day: DayKey | undefined,
  model: ModelName,
  mode: SiteKind | undefined,
): RecommendationsState {
  const loaded = loadedFor(prev, day, model, mode);
  return loaded === undefined
    ? { status: "loading" }
    : { status: "loaded", requested: day, mode: loaded.mode, result: loaded.result, refreshing: true };
}

/**
 * The state to show for `day`, `model` and `mode`: `state`, except that a result loaded for
 * another day, model or mode reads as loading. The reload effect runs after the render that
 * switches, so without this that render would show the old result under the new day, model or
 * mode.
 */
export function visibleState(
  state: RecommendationsState,
  day: DayKey | undefined,
  model: ModelName,
  mode: SiteKind | undefined,
): RecommendationsState {
  return state.status === "loaded" && loadedFor(state, day, model, mode) === undefined
    ? { status: "loading" }
    : state;
}

/**
 * Loads the forecast for `siteIds` on `day` (undefined for the default day), with `model` as the
 * primary model, for the list's `mode` (undefined on a site page, which takes a result loaded for
 * any mode). `state` is the unfiltered result with no distances: `useTravelView` adds those from
 * the start point. Undefined `siteIds` means "not yet": nothing loads and the state stays as it is
 * (loading until something has loaded for this day, model and mode). A new set of ids reloads with
 * the previous result still shown (`refreshing`), unless that result already has every one of them
 * for this day, model and mode. Another day, model or mode shows loading until it arrives (from the
 * cache, for a model switch: both models are in every cached response).
 *
 * `mode` is the route's, never the one a site page gets from the site's kind: that one changes
 * when the catalog arrives, which would restart the page's load.
 */
export function useRecommendations(
  debug: DebugParams,
  day: DayKey | undefined,
  model: ModelName,
  mode: SiteKind | undefined,
  siteIds: readonly string[] | undefined,
): ForecastLoad {
  const [base, setBase] = useState<RecommendationsState>({ status: "loading" });
  // Read by the reload effect to decide whether the loaded result already covers the ids.
  const current = useRef(base);
  current.current = base;

  // Keyed on the string, so a new array with the same ids (every render of `App`) changes nothing.
  // Refresh, retry and resume load these same ids.
  const key = siteIds === undefined ? undefined : weatherLoadKey(day, model, siteIds);
  const ids = useMemo(() => siteIds, [key]);

  const now = useCallback(() => debug.now ?? Date.now(), [debug.now]);
  const deps = useMemo(
    () => ({
      siteProvider: bundledSiteProvider(),
      transport: fetchTransport,
      baseURL: debug.baseURL,
      // Built once here: creating it also removes the old one-blob cache.
      cache: createSiteForecastCache(localStorageStore()),
      now,
    }),
    [debug.baseURL, now],
  );

  // The latest request wins; an older response that lands late is ignored.
  const requestId = useRef(0);
  const pending = useRef<PendingLoad | undefined>(undefined);
  // Loads in flight, so coming back to the page doesn't start a second one while one is running.
  const inFlight = useRef(0);

  const load = useCallback(
    (forceRefresh: boolean) => {
      if (ids === undefined) return;
      const id = ++requestId.current;
      pending.current = { day, model, mode, ids };
      inFlight.current++;
      setBase((prev) => pendingState(prev, day, model, mode));
      getRecommendations({ forceRefresh, day, siteIds: ids, model }, deps).then(
        (result) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          pending.current = undefined;
          setBase({ status: "loaded", requested: day, mode, result, refreshing: false });
        },
        (error: unknown) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          pending.current = undefined;
          console.error("Could not load recommendations", error);
          setBase((prev) =>
            prev.status === "loaded"
              ? { ...prev, refreshing: false, refreshError: describeError(error) }
              : { status: "failed", message: describeError(error) },
          );
        },
      );
    },
    // `model` is here for the switch while the ids are undefined (the list during `routing`): the
    // `ids` memo key doesn't change then, so this dep is what re-runs the effect below, which
    // drops the other model's result. With ids, the key has the model and changes `ids` too.
    // `mode` is here for the same reason, and the key has no mode, so it also covers a switch to
    // a mode that wants the same ids (none in range in either, say).
    [deps, day, model, mode, ids],
  );

  // `load` changes exactly when the day, the model, the mode, the ids or the deps do, so this runs
  // once per new key.
  useEffect(() => {
    const decision = loadDecision(current.current, day, model, mode, ids, pending.current);
    if (decision === "load") {
      load(false);
      return;
    }
    if (decision === "keep") return;
    ++requestId.current;
    pending.current = undefined;
    setBase((p) => droppedState(p, day, model, mode));
  }, [load]);

  // Coming back to the page re-runs a non-forced load (the core cache rules decide whether to
  // fetch) and re-renders the forecast age. While visible, the age also re-renders every minute.
  // `tick` only forces a render: `now` reads the clock itself, and `load` does not depend on it.
  const [, setTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopTimer = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const startTimer = () => {
      stopTimer();
      timer = setInterval(() => setTick((t) => t + 1), TICK_MS);
    };
    const resume = () => {
      setTick((t) => t + 1);
      startTimer();
      if (inFlight.current === 0) load(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") resume();
      else stopTimer();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resume();
    };
    if (document.visibilityState === "visible") startTimer();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  const retry = useCallback(() => load(false), [load]);
  const state = useMemo(() => visibleState(base, day, model, mode), [base, day, model, mode]);
  return { state, now, refresh, retry };
}
