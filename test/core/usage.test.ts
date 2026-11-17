import { describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "../../src/core/keyValueStore";
import { USAGE_KEY, countURL, newPeriods } from "../../src/core/usage";

const at = (iso: string) => Date.parse(iso);
const BASE = "https://example.goatcounter.com/count";

describe("countURL", () => {
  it("builds a page view with a referrer and a screen", () => {
    const url = new URL(
      countURL(BASE, { kind: "pageview", path: "/site/abc", referrer: "https://x.test/a", screen: "390,844,3" }, "42"),
    );
    expect(url.origin + url.pathname).toBe(BASE);
    expect(url.searchParams.get("p")).toBe("/site/abc");
    expect(url.searchParams.get("r")).toBe("https://x.test/a");
    expect(url.searchParams.get("s")).toBe("390,844,3");
    expect(url.searchParams.get("rnd")).toBe("42");
    expect(url.searchParams.has("e")).toBe(false);
  });

  it("omits r and s from a page view that has none", () => {
    const url = new URL(countURL(BASE, { kind: "pageview", path: "/", referrer: "", screen: undefined }, "1"));
    expect(url.searchParams.has("r")).toBe(false);
    expect(url.searchParams.has("s")).toBe(false);
    expect(url.searchParams.get("p")).toBe("/");
  });

  it("marks an event and keeps its name unprefixed", () => {
    const url = new URL(countURL(BASE, { kind: "event", name: "mode/kite" }, "7"));
    expect(url.searchParams.get("p")).toBe("mode/kite");
    expect(url.searchParams.get("e")).toBe("true");
    expect(url.searchParams.has("r")).toBe(false);
  });

  it("round-trips a path that needs encoding", () => {
    const path = "/site/a b&c=d?e#f%20é";
    const url = new URL(countURL(BASE, { kind: "pageview", path }, "1"));
    expect(url.searchParams.get("p")).toBe(path);
  });
});

function memoryStore(initial?: string): KeyValueStore & { set: ReturnType<typeof vi.fn> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(USAGE_KEY, initial);
  return {
    get: (key: string) => data.get(key),
    set: vi.fn((key: string, value: string) => void data.set(key, value)),
  };
}

const stored = (store: KeyValueStore): unknown => JSON.parse(store.get(USAGE_KEY) ?? "null");

describe("newPeriods", () => {
  const tue = at("2026-11-17T19:00:00Z"); // Tue 12:00 MST

  it("reports every period on an empty store and stores the keys", () => {
    const store = memoryStore();
    expect(newPeriods(store, tue)).toEqual(["day", "week", "month"]);
    expect(stored(store)).toEqual({ day: "2026-11-17", week: "2026-11-16", month: "2026-11" });
  });

  it("reports nothing the second time and doesn't write", () => {
    const store = memoryStore();
    newPeriods(store, tue);
    store.set.mockClear();
    expect(newPeriods(store, tue)).toEqual([]);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("reports only the day on the next day of the same week and month", () => {
    const store = memoryStore();
    newPeriods(store, tue);
    expect(newPeriods(store, at("2026-11-18T19:00:00Z"))).toEqual(["day"]);
  });

  it("reports the day and week on the next Monday", () => {
    const store = memoryStore();
    newPeriods(store, tue);
    expect(newPeriods(store, at("2026-11-23T19:00:00Z"))).toEqual(["day", "week"]); // Mon
  });

  it("reports the day and month when a month starts mid-week", () => {
    const store = memoryStore();
    newPeriods(store, at("2026-11-30T19:00:00Z")); // Mon
    expect(newPeriods(store, at("2026-12-01T19:00:00Z"))).toEqual(["day", "month"]); // Tue
  });

  it("reports all three when a month starts on a Monday", () => {
    const store = memoryStore();
    newPeriods(store, at("2026-05-31T18:00:00Z")); // Sun
    expect(newPeriods(store, at("2026-06-01T18:00:00Z"))).toEqual(["day", "week", "month"]); // Mon
  });

  it("treats corrupt JSON as empty", () => {
    expect(newPeriods(memoryStore("{nope"), tue)).toEqual(["day", "week", "month"]);
  });

  it("treats a non-object value as empty", () => {
    expect(newPeriods(memoryStore("[1]"), tue)).toEqual(["day", "week", "month"]);
  });

  it("treats a missing or non-string field as not stored", () => {
    expect(newPeriods(memoryStore(JSON.stringify({ day: "2026-11-17" })), tue)).toEqual(["week", "month"]);
    const store = memoryStore(JSON.stringify({ day: "2026-11-17", week: 5, month: "2026-11" }));
    expect(newPeriods(store, tue)).toEqual(["week"]);
  });

  it("still reports the periods when the store can't be written", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store: KeyValueStore = {
      get: () => undefined,
      set: () => {
        throw new Error("quota");
      },
    };
    expect(newPeriods(store, tue)).toEqual(["day", "week", "month"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
