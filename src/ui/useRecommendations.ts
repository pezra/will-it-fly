import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createSiteForecastCache } from "../core/forecast/siteForecastCache";
import { getRecommendations } from "../core/recommendation/recommendationService";
import type { RecommendationResult } from "../core/recommendation/types";
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
interface PendingLoad {
  day: DayKey | undefined;
  ids: readonly string[];
}

/**
 * Loads the forecast for `siteIds` on `day` (undefined for the default day). `state` is the
 * unfiltered result with no distances: `useTravelView` adds those from the start point. Undefined
 * `siteIds` means "not yet": nothing loads and the state stays as it is (loading until something
 * has loaded for this day). A new set of ids reloads with the previous result still shown
 * (`refreshing`), unless that result already has every one of them for this day. Another day
 * shows loading until it arrives.
 */
export function useRecommendations(
  debug: DebugParams,
  day: DayKey | undefined,
  siteIds: readonly string[] | undefined,
): ForecastLoad {
  const [base, setBase] = useState<RecommendationsState>({ status: "loading" });
  // Read by the reload effect to decide whether the loaded result already covers the ids.
  const current = useRef(base);
  current.current = base;

  // Keyed on the string, so a new array with the same ids (every render of `App`) changes nothing.
  // Refresh, retry and resume load these same ids.
  const key = siteIds === undefined ? undefined : weatherLoadKey(day, siteIds);
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
      pending.current = { day, ids };
      inFlight.current++;
      // Another day's result is never shown as this day's while it loads.
      setBase((prev) =>
        prev.status === "loaded" && prev.requested === day
          ? { status: "loaded", requested: day, result: prev.result, refreshing: true }
          : { status: "loading" },
      );
      getRecommendations({ forceRefresh, day, siteIds: ids, model: "ecmwf" }, deps).then(
        (result) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          pending.current = undefined;
          setBase({ status: "loaded", requested: day, result, refreshing: false });
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
    [deps, day, ids],
  );

  // `load` changes exactly when the day, the ids or the deps do, so this runs once per new key.
  useEffect(() => {
    const prev = current.current;
    const loaded = prev.status === "loaded" && prev.requested === day ? prev : undefined;
    if (ids !== undefined && (loaded === undefined || !containsSites(loaded.result, ids))) {
      load(false);
      return;
    }
    // Nothing to load. A load in flight that covers these ids may land; any other is dropped, so
    // it can't replace what is on screen later (a site page's single site over the list, say).
    const inFlightLoad = pending.current;
    const covering =
      ids !== undefined &&
      inFlightLoad !== undefined &&
      inFlightLoad.day === day &&
      ids.every((id) => inFlightLoad.ids.includes(id));
    if (covering) return;
    ++requestId.current;
    pending.current = undefined;
    setBase((p) => {
      // A failure from the load that was just dropped must not sit over the next stage.
      if (p.status === "failed") return { status: "loading" };
      if (p.status !== "loaded") return p;
      if (p.requested !== day) return { status: "loading" };
      const { refreshError: _dropped, ...rest } = p;
      return { ...rest, refreshing: false };
    });
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
  return { state: base, now, refresh, retry };
}
