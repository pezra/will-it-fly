import { useEffect } from "preact/hooks";
import type { KeyValueStore } from "../core/keyValueStore";
import type { ModelName } from "../core/scoring/hourEvaluator";
import type { SiteKind } from "../core/sites/site";
import { MINUTES_PER_HOUR } from "../core/units";
import { countURL, newPeriods } from "../core/usage";
import type { Hit, Period } from "../core/usage";
import type { Route } from "./route";
import { localStorageStore } from "./storage";

/** GoatCounter's count endpoint for this app's site. */
const COUNT_BASE = "https://will-it-fly.goatcounter.com/count";
/** The one host that counts, so dev servers, LAN previews and forks never do. */
const PRODUCTION_HOST = "pezra.github.io";
/** Keeps a junk `#/site/...` hash from flooding the dashboard with long paths. */
const MAX_PATH_LENGTH = 200;

/** Every event the app sends, so a typo or an unknown name fails the type check. */
export type UsageEvent =
  | `mode/${"fly" | "kite"}`
  | `model/${ModelName}`
  | `drive/fly/${number}h`
  | `drive/kite/${number}m`
  | "start/search"
  | "start/location"
  | "example/boulder"
  | "refresh"
  | "briefing/claude"
  | "briefing/chatgpt"
  | "briefing/copy"
  | `active/${Period}`;

/**
 * The page a route counts as: the list or the site, never the day or the model. The site id goes
 * as is, so the dashboard reads `/site/rmhpa/lookout`; `countURL` encodes the whole path.
 */
export function usagePath(route: Route): string {
  const path =
    route.page === "site" ? `/site/${route.id}` : route.mode === "kiting" ? "/kite" : "/";
  return path.slice(0, MAX_PATH_LENGTH);
}

/** The event for choosing `kind` in the Mode select. */
export function modeEventName(kind: SiteKind): UsageEvent {
  return kind === "kiting" ? "mode/kite" : "mode/fly";
}

/** The event for choosing a drive limit of `minutes` in `mode`: hours when flying, minutes when kiting. */
export function driveEventName(mode: SiteKind, minutes: number): UsageEvent {
  return mode === "kiting" ? `drive/kite/${minutes}m` : `drive/fly/${minutes / MINUTES_PER_HOUR}h`;
}

/** An http(s) `referrer` reduced to its origin and path, or "" for anything else (app referrers have no origin). */
export function referrerForCount(referrer: string): string {
  try {
    const url = new URL(referrer);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin + url.pathname : "";
  } catch {
    return "";
  }
}

/** Whether usage is sent: only from a production build on the production host. */
export function sendsUsage(prod: boolean, hostname: string): boolean {
  return prod && hostname === PRODUCTION_HOST;
}

/** What the tracker needs from the browser, injected so tests can fake it. */
export interface TrackerDeps {
  enabled: () => boolean;
  /** `navigator.sendBeacon`. Returns false when it didn't queue the send (or there is none). */
  beacon: (url: string) => boolean;
  /** The fallback: loads `url` as an image. */
  image: (url: string) => void;
  store: KeyValueStore;
  now: () => number;
  screen: () => string;
  referrer: () => string;
  rnd: () => string;
}

/** The counters. None of them throws, and all do nothing unless `deps.enabled()`. */
export function createTracker(deps: TrackerDeps): {
  pageview(path: string): void;
  event(name: UsageEvent): void;
  checkActive(): void;
} {
  let firstPageview = true;
  // The markers also live in memory, so a device whose store can't be written counts each period
  // once per page load, not again on every return to the tab.
  const memory = new Map<string, string>();
  const markers: KeyValueStore = {
    get: (key) => deps.store.get(key) ?? memory.get(key),
    set: (key, value) => {
      memory.set(key, value);
      deps.store.set(key, value);
    },
  };

  function send(hit: Hit): void {
    const url = countURL(COUNT_BASE, hit, deps.rnd());
    try {
      if (deps.beacon(url)) return;
    } catch (error) {
      console.warn("Could not send a usage beacon", error);
    }
    deps.image(url);
  }

  /** Sends the hit `make` builds, logging and swallowing any failure. */
  function guarded(make: () => Hit): void {
    try {
      if (!deps.enabled()) return;
      send(make());
    } catch (error) {
      console.warn("Could not count usage", error);
    }
  }

  function event(name: UsageEvent): void {
    guarded(() => ({ kind: "event", name, screen: deps.screen() }));
  }

  return {
    pageview(path) {
      guarded(() => {
        const referrer = firstPageview ? referrerForCount(deps.referrer()) : undefined;
        firstPageview = false;
        return { kind: "pageview", path, referrer, screen: deps.screen() };
      });
    },
    event,
    checkActive() {
      try {
        if (!deps.enabled()) return;
        for (const period of newPeriods(markers, deps.now())) event(`active/${period}`);
      } catch (error) {
        console.warn("Could not check usage periods", error);
      }
    },
  };
}

// Browser globals are touched only inside these functions, so importing this module is safe in Node.
const tracker = createTracker({
  enabled: () => sendsUsage(import.meta.env.PROD, window.location.hostname),
  beacon: (url) => (typeof navigator.sendBeacon === "function" ? navigator.sendBeacon(url) : false),
  image: (url) => {
    new Image().src = url;
  },
  store: localStorageStore(),
  now: Date.now,
  screen: () => `${screen.width},${screen.height},${window.devicePixelRatio}`,
  referrer: () => document.referrer,
  rnd: () => Math.random().toString(36).slice(2),
});

export const trackEvent = tracker.event;

/**
 * Counts a page view for each new normalized path of `route`, so a model rewrite or a day change
 * doesn't count again. A new day, week or month is checked with each page view and on each return
 * to the app, so a tab left open across midnight still counts the new day.
 */
export function useUsage(route: Route): void {
  const path = usagePath(route);
  useEffect(() => {
    tracker.pageview(path);
    tracker.checkActive();
  }, [path]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") tracker.checkActive();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}
