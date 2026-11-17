import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE_KEY } from "../../src/core/usage";
import { RADIUS_CHOICES } from "../../src/ui/travelSettings";
import {
  createTracker,
  driveEventName,
  modeEventName,
  modelEventName,
  referrerForCount,
  sendsUsage,
  usagePath,
} from "../../src/ui/usage";
import type { TrackerDeps } from "../../src/ui/usage";
import { mapStore } from "../support/builders";

afterEach(() => vi.restoreAllMocks());

describe("usagePath", () => {
  it("is / for the Fly list, whatever the day or model", () => {
    expect(usagePath({ page: "list", mode: "flying" })).toBe("/");
    expect(usagePath({ page: "list", mode: "flying", day: "2026-11-18", model: "ecmwf" })).toBe("/");
  });

  it("is /kite for the Kite list, with or without a day", () => {
    expect(usagePath({ page: "list", mode: "kiting" })).toBe("/kite");
    expect(usagePath({ page: "list", mode: "kiting", day: "2026-11-18" })).toBe("/kite");
  });

  it("is /site/<encoded id> for a site, ignoring day and model", () => {
    expect(usagePath({ page: "site", id: "rmhpa/lookout", day: "2026-11-18", model: "rrfs" })).toBe(
      "/site/rmhpa%2Flookout",
    );
  });

  it("caps the path at 200 characters", () => {
    expect(usagePath({ page: "site", id: "x".repeat(500) })).toHaveLength(200);
  });
});

describe("event names", () => {
  it("names the modes", () => {
    expect(modeEventName("flying")).toBe("mode/fly");
    expect(modeEventName("kiting")).toBe("mode/kite");
  });

  it("names the models", () => {
    expect(modelEventName("ecmwf")).toBe("model/ecmwf");
    expect(modelEventName("rrfs")).toBe("model/rrfs");
  });

  it("names every drive time choice", () => {
    expect(RADIUS_CHOICES.flying.map((m) => driveEventName("flying", m))).toEqual([
      "drive/fly/1h",
      "drive/fly/2h",
      "drive/fly/3h",
      "drive/fly/4h",
    ]);
    expect(RADIUS_CHOICES.kiting.map((m) => driveEventName("kiting", m))).toEqual([
      "drive/kite/15m",
      "drive/kite/30m",
      "drive/kite/60m",
    ]);
  });
});

describe("referrerForCount", () => {
  it("keeps only the origin and path", () => {
    expect(referrerForCount("https://example.com/a/b?q=1#frag")).toBe("https://example.com/a/b");
  });

  it("is empty for nothing or garbage", () => {
    expect(referrerForCount("")).toBe("");
    expect(referrerForCount("not a url")).toBe("");
  });
});

describe("sendsUsage", () => {
  it("sends from a production build on a real host", () => {
    expect(sendsUsage(true, "pezra.github.io")).toBe(true);
  });

  it("never sends from a dev build", () => {
    expect(sendsUsage(false, "pezra.github.io")).toBe(false);
  });

  it.each(["localhost", "127.0.0.1", "[::1]", "::1"])("never sends from %s", (host) => {
    expect(sendsUsage(true, host)).toBe(false);
  });
});

const NOW = Date.UTC(2026, 10, 18, 19, 0);

/** Fake deps that record each URL sent to the beacon and to the image fallback. */
function fakeDeps(overrides: Partial<TrackerDeps> = {}) {
  const beacons: string[] = [];
  const images: string[] = [];
  const deps: TrackerDeps = {
    enabled: () => true,
    beacon: (url) => {
      beacons.push(url);
      return true;
    },
    image: (url) => void images.push(url),
    store: mapStore(),
    now: () => NOW,
    screen: () => "1000,800,2",
    referrer: () => "https://ref.example/page?x=1#y",
    rnd: () => "abc",
    ...overrides,
  };
  return { deps, beacons, images };
}

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("createTracker", () => {
  it("does nothing when disabled", () => {
    const store = mapStore();
    const set = vi.spyOn(store, "set");
    const { deps, beacons, images } = fakeDeps({ enabled: () => false, store });
    const tracker = createTracker(deps);
    tracker.pageview("/");
    tracker.event("refresh");
    tracker.checkActive();
    expect(beacons).toEqual([]);
    expect(images).toEqual([]);
    expect(set).not.toHaveBeenCalled();
  });

  it("sends the referrer, reduced, on the first page view only", () => {
    const { deps, beacons } = fakeDeps();
    const tracker = createTracker(deps);
    tracker.pageview("/");
    tracker.pageview("/kite");
    expect(params(beacons[0]!).get("r")).toBe("https://ref.example/page");
    expect(params(beacons[0]!).get("p")).toBe("/");
    expect(params(beacons[0]!).get("s")).toBe("1000,800,2");
    expect(params(beacons[0]!).get("e")).toBeNull();
    expect(params(beacons[1]!).has("r")).toBe(false);
  });

  it("sends an event with e=true", () => {
    const { deps, beacons } = fakeDeps();
    createTracker(deps).event("mode/kite");
    expect(params(beacons[0]!).get("p")).toBe("mode/kite");
    expect(params(beacons[0]!).get("e")).toBe("true");
    expect(params(beacons[0]!).has("r")).toBe(false);
  });

  it("falls back to the image when the beacon returns false", () => {
    const { deps, images } = fakeDeps({ beacon: () => false });
    createTracker(deps).event("refresh");
    expect(images).toHaveLength(1);
    expect(params(images[0]!).get("p")).toBe("refresh");
  });

  it("falls back to the image when there is no beacon", () => {
    const { deps, images } = fakeDeps({ beacon: undefined });
    createTracker(deps).pageview("/");
    expect(images).toHaveLength(1);
  });

  it("falls back to the image when the beacon throws, without throwing", () => {
    const { deps, images } = fakeDeps({
      beacon: () => {
        throw new Error("blocked");
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => createTracker(deps).event("refresh")).not.toThrow();
    expect(images).toHaveLength(1);
  });

  it("never throws when the image fails too", () => {
    const { deps } = fakeDeps({
      beacon: undefined,
      image: () => {
        throw new Error("no image");
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tracker = createTracker(deps);
    expect(() => {
      tracker.pageview("/");
      tracker.event("refresh");
      tracker.checkActive();
    }).not.toThrow();
  });

  it("sends active/day, week and month once per period", () => {
    const { deps, beacons } = fakeDeps();
    const tracker = createTracker(deps);
    tracker.checkActive();
    expect(beacons.map((url) => params(url).get("p"))).toEqual(["active/day", "active/week", "active/month"]);
    expect(beacons.every((url) => params(url).get("e") === "true")).toBe(true);
    tracker.checkActive();
    expect(beacons).toHaveLength(3);
  });

  it("remembers the periods under the usage key", () => {
    const map = new Map<string, string>();
    createTracker(fakeDeps({ store: mapStore(map) }).deps).checkActive();
    expect(map.has(USAGE_KEY)).toBe(true);
  });

  it("does not throw when the store can't be written", () => {
    const store = mapStore();
    store.set = () => {
      throw new Error("full");
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, beacons } = fakeDeps({ store });
    expect(() => createTracker(deps).checkActive()).not.toThrow();
    expect(beacons).toHaveLength(3);
  });
});
