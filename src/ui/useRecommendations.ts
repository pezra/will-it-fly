import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchFailureKind } from "../core/forecast/fetchFailure";
import type { FetchFailureKind } from "../core/forecast/fetchFailure";
import { createSiteForecastCache } from "../core/forecast/siteForecastCache";
import { DayOutOfRangeError, getRecommendations } from "../core/recommendation/recommendationService";
import type { RecommendationResult } from "../core/recommendation/types";
import type { ModelName } from "../core/scoring/hourEvaluator";
import type { SiteKind } from "../core/sites/site";
import { bundledSiteProvider } from "../core/sites/siteProvider";
import { containsSites, weatherLoadKey } from "../core/travel/inRange";
import type { DayKey } from "../core/time";
import type { DebugParams } from "./debugParams";
import { createVisibilityTracker, once } from "./errorReporting";
import { isHeld, loadFailureMessage } from "./format";
import type { LocationResult, LocationStatus } from "./location";
import { reportError } from "./sentry";
import { localStorageStore } from "./storage";
import { fetchTransport } from "./transport";

/**
 * The first failed load of a page load is reported; retries during an outage would only repeat it,
 * and the transport has already reported the API failure underneath.
 */
const reportLoadFailure = once(reportError);

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
  /** Until when Retry and Refresh are held after a rate limit (epoch ms, `now()`'s clock). */
  retryAt: number | undefined;
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

/** How a load settled: a result, with the cause if it fell back to the cache, or a failure's kind. */
export type LoadOutcome =
  | { ok: true; fallback: FetchFailureKind | undefined }
  | { ok: false; kind: FetchFailureKind };

/** How long Retry and Refresh stay held after a rate limit. */
export const RATE_LIMIT_HOLD_MS = 90_000;

/**
 * The end of the hold after a load that settled as `outcome` at `now`, given the hold `prev`. A rate
 * limit (as a failure or as the cause of a fallback) starts one; any other failure or fallback ends
 * it, so a later server error enables Retry at once; a clean success leaves it as it was.
 */
export function nextRetryAt(outcome: LoadOutcome, now: number, prev: number | undefined): number | undefined {
  const kind = outcome.ok ? outcome.fallback : outcome.kind;
  if (kind === undefined) return prev;
  return kind === "rateLimited" ? now + RATE_LIMIT_HOLD_MS : undefined;
}

/**
 * What to do with a finished load: show it, retry now, or retry when the page is next visible.
 * A network failure is retried once, since a request frozen with the page or a dropped connection
 * usually works the second time. A network fallback is retried only if the page was hidden during
 * the load, as the freeze is then the likely cause; one seen while visible is a real outage, and
 * the cached result is the best there is. A retry's outcome is always shown, so there is never a
 * second one.
 */
export function afterLoad(o: {
  outcome: LoadOutcome;
  isRetry: boolean;
  /** Whether the page was hidden at any time during the load. */
  hiddenDuring: boolean;
  hiddenNow: boolean;
}): "show" | "retry" | "retryWhenVisible" {
  if (o.isRetry) return "show";
  const { outcome } = o;
  const retriable = outcome.ok ? outcome.fallback === "network" && o.hiddenDuring : outcome.kind === "network";
  if (!retriable) return "show";
  return o.hiddenNow ? "retryWhenVisible" : "retry";
}

/**
 * What coming back to the page loads, given the retry remembered for when it is visible and the
 * loads in flight: the remembered retry if there is one (its load has settled, though a newer one
 * may be in flight), else a plain load if none is in flight, else nothing.
 */
export function resumeAction(
  retryOnVisible: { forceRefresh: boolean } | undefined,
  inFlight: number,
): { load: true; forceRefresh: boolean; isRetry: boolean } | { load: false } {
  if (retryOnVisible !== undefined) return { load: true, forceRefresh: retryOnVisible.forceRefresh, isRetry: true };
  return inFlight === 0 ? { load: true, forceRefresh: false, isRetry: false } : { load: false };
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
  const [retryAt, setRetryAt] = useState<number | undefined>(undefined);
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
  // The retry of a load that settled while the page was hidden, run when it is next visible.
  const retryOnVisible = useRef<{ forceRefresh: boolean } | undefined>(undefined);
  // Created once. A page that starts hidden (opened in a background tab) has no `visibilitychange`
  // for that, so it is recorded here.
  const [tracker] = useState(() => {
    const created = createVisibilityTracker();
    if (document.visibilityState === "hidden") created.hidden(performance.now());
    return created;
  });

  const load = useCallback(
    (forceRefresh: boolean, isRetry = false) => {
      retryOnVisible.current = undefined;
      if (ids === undefined) return;
      const id = ++requestId.current;
      pending.current = { day, model, mode, ids };
      inFlight.current++;
      setBase((prev) => pendingState(prev, day, model, mode));
      const startedAt = performance.now();
      // Called only while this load is the latest. A retry leaves `pending` and the state as they
      // are, so the failure or fallback never shows in between.
      const next = (outcome: LoadOutcome): "show" | "retry" | "retryWhenVisible" => {
        const hiddenNow = document.visibilityState === "hidden";
        // Also read now: on a thaw the rejection can land before `visibilitychange` is delivered.
        const hiddenDuring = tracker.hiddenBetween(startedAt) || hiddenNow;
        const action = afterLoad({ outcome, isRetry, hiddenDuring, hiddenNow });
        // This render's `load` on purpose: the retry repeats the same day, model, mode and ids.
        if (action === "retry") load(forceRefresh, true);
        else if (action === "retryWhenVisible") retryOnVisible.current = { forceRefresh };
        if (action === "show") setRetryAt((prev) => nextRetryAt(outcome, now(), prev));
        return action;
      };
      getRecommendations({ forceRefresh, day, siteIds: ids, model }, deps).then(
        (result) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          if (next({ ok: true, fallback: result.fallback }) !== "show") return;
          pending.current = undefined;
          setBase({ status: "loaded", requested: day, mode, result, refreshing: false });
        },
        (error: unknown) => {
          inFlight.current--;
          if (id !== requestId.current) return;
          if (next({ ok: false, kind: fetchFailureKind(error) }) !== "show") return;
          pending.current = undefined;
          console.error("Could not load recommendations", error);
          // A day out of range comes from an old link, not a bug, and the page already says so.
          if (!(error instanceof DayOutOfRangeError)) reportLoadFailure(error);
          setBase((prev) =>
            prev.status === "loaded"
              ? { ...prev, refreshing: false, refreshError: loadFailureMessage(error) }
              : { status: "failed", message: loadFailureMessage(error) },
          );
        },
      );
    },
    // `model` is here for the switch while the ids are undefined (the list during `routing`): the
    // `ids` memo key doesn't change then, so this dep is what re-runs the effect below, which
    // drops the other model's result. With ids, the key has the model and changes `ids` too.
    // `mode` is here for the same reason, and the key has no mode, so it also covers a switch to
    // a mode that wants the same ids (none in range in either, say).
    [deps, day, model, mode, ids, now],
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
    // The dropped load's retry, if it was waiting for the page to be visible, goes with it.
    retryOnVisible.current = undefined;
    setBase((p) => droppedState(p, day, model, mode));
  }, [load]);

  // Coming back to the page runs the retry waiting for it, or else re-runs a non-forced load (the
  // core cache rules decide whether to fetch), and re-renders the forecast age. While visible, the
  // age also re-renders every minute. `tick` only forces a render: `now` reads the clock itself,
  // and `load` does not depend on it.
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
      // Decided before loading, since `load` clears the remembered retry.
      const action = resumeAction(retryOnVisible.current, inFlight.current);
      if (action.load) load(action.forceRefresh, action.isRetry);
    };
    // The tracker hears each change before `resume` runs, so a retry started here doesn't count
    // the page as hidden after its own start.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tracker.visible(performance.now());
        resume();
      } else {
        tracker.hidden(performance.now());
        stopTimer();
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      tracker.visible(performance.now());
      resume();
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

  // Held after a rate limit, so a button clicked in the last render before the hold ends does nothing.
  const refresh = useCallback(() => {
    if (!isHeld(retryAt, now())) load(true);
  }, [load, retryAt, now]);
  const retry = useCallback(() => {
    if (!isHeld(retryAt, now())) load(false);
  }, [load, retryAt, now]);
  const state = useMemo(() => visibleState(base, day, model, mode), [base, day, model, mode]);
  return { state, now, refresh, retry, retryAt };
}
