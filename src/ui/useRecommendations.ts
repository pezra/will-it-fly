import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createForecastCache } from "../core/forecast/forecastCache";
import { getRecommendations } from "../core/recommendation/recommendationService";
import { withDistances } from "../core/recommendation/ranker";
import type { RecommendationResult } from "../core/recommendation/types";
import { bundledSiteProvider } from "../core/sites/siteProvider";
import type { DebugParams } from "./debugParams";
import { requestLocation } from "./location";
import type { LocationResult, LocationStatus } from "./location";
import { localStorageStore } from "./storage";
import { fetchTransport } from "./transport";

export type RecommendationsState =
  | { status: "loading" }
  | {
      status: "loaded";
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
  /** The clock the UI should use for ages (the debug `now` when set). */
  now: () => number;
  refresh: () => void;
  retry: () => void;
}

/** How often the forecast age re-renders while the page is visible. */
const TICK_MS = 60_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads the forecast and the location in parallel. The forecast never waits for location: the
 * ranking is computed without distances and `withDistances` fills them in (and re-ranks) when the
 * position arrives, with no refetch.
 */
export function useRecommendations(debug: DebugParams): Recommendations {
  const [base, setBase] = useState<RecommendationsState>({ status: "loading" });
  const [locationResult, setLocationResult] = useState<LocationResult | undefined>(undefined);

  const now = useCallback(() => debug.now ?? Date.now(), [debug.now]);
  const deps = useMemo(
    () => ({
      siteProvider: bundledSiteProvider(),
      transport: fetchTransport,
      baseURL: debug.baseURL,
      cache: createForecastCache(localStorageStore()),
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
      setBase((prev) =>
        prev.status === "loaded"
          ? { status: "loaded", result: prev.result, refreshing: true }
          : { status: "loading" },
      );
      getRecommendations({ forceRefresh }, deps).then(
        (result) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          setBase({ status: "loaded", result, refreshing: false });
        },
        (error: unknown) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          console.error("Could not load recommendations", error);
          setBase((prev) =>
            prev.status === "loaded"
              ? {
                  status: "loaded",
                  result: prev.result,
                  refreshing: false,
                  refreshError: describe(error),
                }
              : { status: "failed", message: describe(error) },
          );
        },
      );
    },
    [deps],
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

  useEffect(() => {
    let cancelled = false;
    if (debug.noLocation === true) {
      setLocationResult({ status: "denied" });
    } else if (debug.location !== undefined) {
      setLocationResult({ status: "found", coordinate: debug.location });
    } else {
      void requestLocation().then((r) => {
        if (!cancelled) setLocationResult(r);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [debug.noLocation, debug.location]);

  const coordinate = locationResult?.coordinate;
  const state = useMemo<RecommendationsState>(
    () =>
      base.status === "loaded" && coordinate !== undefined
        ? { ...base, result: withDistances(base.result, coordinate) }
        : base,
    [base, coordinate],
  );

  const refresh = useCallback(() => load(true), [load]);
  const retry = useCallback(() => load(false), [load]);
  return { state, location: locationResult?.status ?? "pending", now, refresh, retry };
}
