import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DEFAULT_CACHE_KEY, createForecastCache } from "../core/forecast/forecastCache";
import { getRecommendations } from "../core/recommendation/recommendationService";
import type { RecommendationResult } from "../core/recommendation/types";
import { bundledSiteProvider } from "../core/sites/siteProvider";
import type { DayKey } from "../core/time";
import type { DebugParams } from "./debugParams";
import { describeError } from "./format";
import { locate } from "./location";
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

export interface Recommendations {
  state: RecommendationsState;
  location: LocationStatus;
  /** The geolocation answer, undefined while pending. */
  locationResult: LocationResult | undefined;
  /** The clock the UI should use for ages (the debug `now` when set). */
  now: () => number;
  /**
   * Replaces the location after the user asks for it again. A load-time answer that arrives
   * later is ignored.
   */
  relocate: (result: LocationResult) => void;
  refresh: () => void;
  retry: () => void;
}

/** The cache slot for a single day after tomorrow. Only the last one fetched is kept. */
const DAY_CACHE_KEY = `${DEFAULT_CACHE_KEY}/day`;

/** How often the forecast age re-renders while the page is visible. */
const TICK_MS = 60_000;

/**
 * Loads the forecast and the location in parallel. The forecast never waits for location, and
 * `state` is the unfiltered result with no distances: `useTravel` adds those from the start point,
 * so a start or radius change never reloads the forecast. `day` is the day to show, undefined for
 * the default; changing it loads that day (from the cache when it can) and shows loading until it
 * arrives.
 */
export function useRecommendations(debug: DebugParams, day: DayKey | undefined): Recommendations {
  const [base, setBase] = useState<RecommendationsState>({ status: "loading" });
  const [locationResult, setLocationResult] = useState<LocationResult | undefined>(undefined);

  const now = useCallback(() => debug.now ?? Date.now(), [debug.now]);
  const deps = useMemo(
    () => ({
      siteProvider: bundledSiteProvider(),
      transport: fetchTransport,
      baseURL: debug.baseURL,
      cache: createForecastCache(localStorageStore()),
      dayCache: createForecastCache(localStorageStore(), DAY_CACHE_KEY),
      now,
    }),
    [debug.baseURL, now],
  );

  // The latest request wins; an older response that lands late is ignored.
  const requestId = useRef(0);
  // Loads in flight, so coming back to the page doesn't start a second one while one is running.
  const inFlight = useRef(0);

  const load = useCallback(
    (forceRefresh: boolean) => {
      const id = ++requestId.current;
      inFlight.current++;
      // Another day's result is never shown as this day's while it loads.
      setBase((prev) =>
        prev.status === "loaded" && prev.requested === day
          ? { status: "loaded", requested: day, result: prev.result, refreshing: true }
          : { status: "loading" },
      );
      getRecommendations({ forceRefresh, day }, deps).then(
        (result) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          setBase({ status: "loaded", requested: day, result, refreshing: false });
        },
        (error: unknown) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          console.error("Could not load recommendations", error);
          setBase((prev) =>
            prev.status === "loaded"
              ? { ...prev, refreshing: false, refreshError: describeError(error) }
              : { status: "failed", message: describeError(error) },
          );
        },
      );
    },
    [deps, day],
  );

  useEffect(() => {
    load(false);
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

  const refresh = useCallback(() => load(true), [load]);
  const retry = useCallback(() => load(false), [load]);
  return {
    state: base,
    location: locationResult?.status ?? "pending",
    locationResult,
    now,
    relocate,
    refresh,
    retry,
  };
}
