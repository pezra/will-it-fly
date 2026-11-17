import { describe, expect, it } from "vitest";
import {
  apiFailure,
  createApiFailureFilter,
  createEventCap,
  isLocalHost,
  makeApiFailureReporter,
  makeBeforeSend,
  MAX_EVENTS_PER_LOAD,
  reportingEnabled,
} from "../../src/ui/errorReporting";

describe("isLocalHost", () => {
  it("isTrueForLoopbackHosts", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("[::1]")).toBe(true);
  });
  it("isFalseForOtherHosts", () => {
    expect(isLocalHost("pezra.github.io")).toBe(false);
    expect(isLocalHost("app.test")).toBe(false);
  });
});

describe("reportingEnabled", () => {
  const on = { prod: true, hostname: "pezra.github.io", dsn: "https://k@o.ingest.sentry.io/1" };
  it("isTrueWhenProdRemoteAndDsnSet", () => {
    expect(reportingEnabled(on)).toBe(true);
  });
  it("isFalseOutsideProd", () => {
    expect(reportingEnabled({ ...on, prod: false })).toBe(false);
  });
  it("isFalseOnALocalHost", () => {
    expect(reportingEnabled({ ...on, hostname: "localhost" })).toBe(false);
  });
  it("isFalseWithoutADsn", () => {
    expect(reportingEnabled({ ...on, dsn: "" })).toBe(false);
  });
});

describe("apiFailure", () => {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=40.1&longitude=-105.2#h";
  it("isUndefinedForSuccessStatuses", () => {
    expect(apiFailure(url, { status: 200 })).toBeUndefined();
    expect(apiFailure(url, { status: 204 })).toBeUndefined();
  });
  it("namesTheStatusOtherwise", () => {
    for (const status of [304, 404, 429, 503]) {
      expect(apiFailure(url, { status })?.kind).toBe(`http ${status}`);
    }
  });
  it("callsATimeoutErrorATimeout", () => {
    expect(apiFailure(url, { error: new DOMException("x", "TimeoutError") })?.kind).toBe("timeout");
    expect(apiFailure(url, { error: { name: "TimeoutError" } })?.kind).toBe("timeout");
  });
  it("callsAnythingElseANetworkError", () => {
    expect(apiFailure(url, { error: new TypeError("Failed to fetch") })?.kind).toBe("network");
    expect(apiFailure(url, { error: "x" })?.kind).toBe("network");
  });
  it("keepsOnlyTheHostAndPath", () => {
    expect(apiFailure(url, { status: 500 })).toEqual({
      host: "api.open-meteo.com",
      path: "/v1/forecast",
      kind: "http 500",
    });
  });
  it("dropsCoordinatesFromTheRoutePath", () => {
    const failure = apiFailure(
      "https://router.project-osrm.org/table/v1/driving/-105.27,40.02;-105.3,40.1?sources=0",
      { status: 500 },
    );
    expect(failure?.path).toBe("/table/v1/driving");
    expect(JSON.stringify(failure)).not.toMatch(/\d+\.\d+/);
  });
  it("dropsTheSearchText", () => {
    const failure = apiFailure("https://nominatim.openstreetmap.org/search?q=Boulder", {
      status: 500,
    });
    expect(failure?.path).toBe("/search");
  });
});


describe("createApiFailureFilter", () => {
  const failure = { host: "a.test", path: "/x", kind: "network" };
  it("passesTheFirstFailureOnly", () => {
    const filter = createApiFailureFilter();
    expect(filter(failure)).toBe(true);
    expect(filter(failure)).toBe(false);
  });
  it("passesAnotherKindOnTheSameHost", () => {
    const filter = createApiFailureFilter();
    filter(failure);
    expect(filter({ ...failure, kind: "timeout" })).toBe(true);
  });
});

describe("createEventCap", () => {
  it("allowsTheFirstMaxCallsThenStops", () => {
    const cap = createEventCap(MAX_EVENTS_PER_LOAD);
    expect(MAX_EVENTS_PER_LOAD).toBe(25);
    for (let i = 0; i < 25; i++) expect(cap()).toBe(true);
    expect(cap()).toBe(false);
  });
});

describe("makeBeforeSend", () => {
  it("passesTheEventItself", () => {
    const event = { message: "m" };
    expect(makeBeforeSend(() => true)(event)).toBe(event);
  });
  it("dropsEventsOverTheCap", () => {
    const beforeSend = makeBeforeSend(createEventCap(2));
    expect(beforeSend({})).not.toBeNull();
    expect(beforeSend({})).not.toBeNull();
    expect(beforeSend({})).toBeNull();
  });
});

describe("makeApiFailureReporter", () => {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=40.1";
  function setup(online = true) {
    const calls: Array<[string, unknown]> = [];
    const network = { online };
    const report = makeApiFailureReporter({
      capture: (message, options) => calls.push([message, options]),
      isOnline: () => network.online,
    });
    return { calls, network, report };
  }
  it("capturesAFailureWithTheExactOptions", () => {
    const { calls, report } = setup();
    report(url, { status: 503 });
    expect(calls).toEqual([
      [
        "api.open-meteo.com http 503",
        {
          level: "error",
          fingerprint: ["api", "api.open-meteo.com", "http 503"],
          tags: { api_host: "api.open-meteo.com", api_kind: "http 503" },
          extra: { path: "/v1/forecast" },
        },
      ],
    ]);
  });
  it("ignoresSuccess", () => {
    const { calls, report } = setup();
    report(url, { status: 200 });
    expect(calls).toEqual([]);
  });
  it("ignoresARepeat", () => {
    const { calls, report } = setup();
    report(url, { status: 503 });
    report(url, { status: 503 });
    expect(calls).toHaveLength(1);
  });
  it("ignoresFailuresWhileOffline", () => {
    const { calls, report } = setup(false);
    report(url, { error: new TypeError("Failed to fetch") });
    expect(calls).toEqual([]);
  });
  it("reportsAFailureFirstSeenOfflineOnceBackOnline", () => {
    const { calls, network, report } = setup(false);
    report(url, { status: 503 });
    network.online = true;
    report(url, { status: 503 });
    expect(calls).toHaveLength(1);
  });
  it("capturesTwoKindsOnOneHost", () => {
    const { calls, report } = setup();
    report(url, { status: 503 });
    report(url, { error: new TypeError("Failed to fetch") });
    expect(calls).toHaveLength(2);
  });
});
