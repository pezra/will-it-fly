import { describe, expect, it } from "vitest";
import {
  apiFailure,
  createApiFailureFilter,
  createEventCap,
  createVisibilityTracker,
  errorKind,
  isLocalHost,
  makeApiFailureReporter,
  makeBeforeSend,
  once,
  MAX_EVENTS_PER_LOAD,
  redactMessage,
  reportingEnabled,
  type ApiOutcome,
  type RequestReport,
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
  it("namesARejectionAfterItsError", () => {
    const rejected = (error: unknown): ApiOutcome => ({ error, stage: "request" });
    expect(apiFailure(url, rejected(new TypeError("Failed to fetch")))?.kind).toBe("TypeError");
    expect(apiFailure(url, rejected(new DOMException("x", "TimeoutError")))?.kind).toBe(
      "TimeoutError",
    );
    expect(apiFailure(url, rejected({ name: "AbortError" }))?.kind).toBe("AbortError");
  });
  it("callsAThrownValueWithoutANameUnknown", () => {
    expect(apiFailure(url, { error: "x", stage: "body" })?.kind).toBe("unknown");
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

describe("errorKind", () => {
  it("isTheErrorsName", () => {
    expect(errorKind(new TypeError("Failed to fetch"))).toBe("TypeError");
    expect(errorKind(new DOMException("x", "TimeoutError"))).toBe("TimeoutError");
  });
  it("isUnknownForANameThatIsNotAnIdentifier", () => {
    expect(errorKind({ name: "a b" })).toBe("unknown");
    expect(errorKind({ name: "https://x.test/?q=1" })).toBe("unknown");
    expect(errorKind({ name: "" })).toBe("unknown");
    expect(errorKind({ name: 7 })).toBe("unknown");
  });
  it("allowsANameOfUpTo40Characters", () => {
    expect(errorKind({ name: "A".repeat(40) })).toBe("A".repeat(40));
    expect(errorKind({ name: "A".repeat(41) })).toBe("unknown");
  });
  it("isUnknownForAValueWithoutAName", () => {
    expect(errorKind("x")).toBe("unknown");
    expect(errorKind(undefined)).toBe("unknown");
    expect(errorKind(null)).toBe("unknown");
  });
});

describe("redactMessage", () => {
  const message = (text: string) => redactMessage(new TypeError(text));
  it("passesTheKnownBrowserMessagesWhole", () => {
    for (const text of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "signal timed out",
    ]) {
      expect(message(text)).toBe(text);
    }
  });
  it("redactsAUrlWithAQuery", () => {
    expect(message("Failed to fetch https://api.open-meteo.com/v1/forecast?latitude=40.1")).toBe(
      "Failed to fetch <redacted>",
    );
  });
  it("redactsAnOsrmPathWithCoordinates", () => {
    expect(message("bad /route/v1/driving/-105.27,40.02;-105.3,40.1 here")).toBe(
      "bad <redacted> here",
    );
  });
  it("redactsWhateverTheCaseOrFormat", () => {
    expect(message("HTTPS://X?Q=1")).toBe("<redacted>");
    expect(message("at -105,40 now")).toBe("at <redacted> now");
    expect(message("at 40.0;-105 now")).toBe("at <redacted> now");
    expect(message("see host/path?q=boulder")).toBe("see <redacted>");
    expect(message("mail me@x.test")).toBe("mail <redacted>");
  });
  it("cutsALongMessageTo200Characters", () => {
    expect(message("word ".repeat(100))).toHaveLength(200);
  });
  it("isUndefinedWithoutAStringMessage", () => {
    expect(redactMessage({ message: 5 })).toBeUndefined();
    expect(redactMessage({})).toBeUndefined();
    expect(redactMessage("Failed to fetch")).toBeUndefined();
    expect(redactMessage(null)).toBeUndefined();
  });
  it("isUndefinedForAnEmptyMessage", () => {
    expect(redactMessage(new TypeError(""))).toBeUndefined();
    expect(redactMessage(new TypeError("  "))).toBeUndefined();
  });
});

describe("createVisibilityTracker", () => {
  it("isVisibleWhenNeverHidden", () => {
    expect(createVisibilityTracker(false).hiddenBetween(10)).toBe(false);
  });
  it("isVisibleWhenHiddenOnlyBeforeTheRequestStarted", () => {
    const tracker = createVisibilityTracker(false);
    tracker.hidden(1);
    tracker.visible(2);
    expect(tracker.hiddenBetween(5)).toBe(false);
  });
  it("isHiddenWhenHiddenAtTheStartAndStillHidden", () => {
    const tracker = createVisibilityTracker(false);
    tracker.hidden(1);
    expect(tracker.hiddenBetween(5)).toBe(true);
  });
  it("isHiddenWhenItBecameHiddenDuringTheRequest", () => {
    const tracker = createVisibilityTracker(false);
    tracker.hidden(7);
    expect(tracker.hiddenBetween(5)).toBe(true);
  });
  it("isHiddenWhenHiddenAtTheStartAndBackBeforeTheEnd", () => {
    const tracker = createVisibilityTracker(false);
    tracker.hidden(1);
    tracker.visible(8);
    expect(tracker.hiddenBetween(5)).toBe(true);
  });
  it("isHiddenWhenItWentHiddenAndCameBackDuringTheRequest", () => {
    const tracker = createVisibilityTracker(false);
    tracker.hidden(6);
    tracker.visible(8);
    expect(tracker.hiddenBetween(5)).toBe(true);
  });
  it("countsBecomingHiddenExactlyAtTheStart", () => {
    const tracker = createVisibilityTracker(false);
    tracker.hidden(5);
    tracker.visible(5.5);
    expect(tracker.hiddenBetween(5)).toBe(true);
  });
  it("doesNotCountBecomingVisibleExactlyAtTheStart", () => {
    const tracker = createVisibilityTracker(false);
    tracker.hidden(1);
    tracker.visible(5);
    expect(tracker.hiddenBetween(5)).toBe(false);
  });
  it("isHiddenWhenCreatedWhileHidden", () => {
    expect(createVisibilityTracker(true).hiddenBetween(5)).toBe(true);
  });
  it("isVisibleOnceACreatedHiddenPageComesBackBeforeTheStart", () => {
    const tracker = createVisibilityTracker(true);
    tracker.visible(2);
    expect(tracker.hiddenBetween(5)).toBe(false);
  });
});

describe("createApiFailureFilter", () => {
  const failure = { host: "a.test", path: "/x", kind: "TypeError" };
  it("passesTheFirstFailureOnly", () => {
    const filter = createApiFailureFilter();
    expect(filter(failure)).toBe(true);
    expect(filter(failure)).toBe(false);
  });
  it("passesAnotherKindOnTheSameHost", () => {
    const filter = createApiFailureFilter();
    filter(failure);
    expect(filter({ ...failure, kind: "TimeoutError" })).toBe(true);
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

describe("once", () => {
  it("callsTheFunctionTheFirstTimeOnly", () => {
    const calls: string[] = [];
    const report = once((s: string) => calls.push(s));
    report("a");
    report("b");
    expect(calls).toEqual(["a"]);
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
  const rejection = (error: unknown, stage: "request" | "body" = "request"): ApiOutcome => ({
    error,
    stage,
  });
  const requestReport = (outcome: ApiOutcome, over: Partial<RequestReport> = {}): RequestReport => ({
    url,
    startedAt: 1_000,
    endedAt: 1_250.4,
    outcome,
    ...over,
  });
  function setup(online = true) {
    const calls: Array<[string, unknown]> = [];
    const state = {
      online,
      connection: undefined as string | undefined,
      hidden: false,
      hiddenNow: false,
      hiddenStarts: [] as number[],
    };
    const report = makeApiFailureReporter({
      capture: (message, options) => calls.push([message, options]),
      isOnline: () => state.online,
      connection: () => state.connection,
      hiddenBetween: (start) => {
        state.hiddenStarts.push(start);
        return state.hidden;
      },
      hiddenNow: () => state.hiddenNow,
    });
    return { calls, state, report };
  }
  it("capturesARejectionWithTheExactOptions", () => {
    const { calls, state, report } = setup();
    state.connection = "4g";
    report(requestReport(rejection(new TypeError("Failed to fetch"))));
    expect(calls).toEqual([
      [
        "api.open-meteo.com TypeError",
        {
          level: "error",
          fingerprint: ["api", "api.open-meteo.com", "TypeError"],
          tags: {
            api_host: "api.open-meteo.com",
            api_kind: "TypeError",
            stage: "request",
            visibility: "visible",
            connection: "4g",
          },
          extra: {
            path: "/v1/forecast",
            elapsed_ms: 250,
            earlier_ok: 0,
            url_length: 100,
            error_message: "Failed to fetch",
          },
        },
      ],
    ]);
    expect(state.hiddenStarts).toEqual([1_000]);
  });
  it("capturesAnHttpFailureWithTheExactOptions", () => {
    const { calls, report } = setup();
    report(requestReport({ status: 503 }));
    expect(calls).toEqual([
      [
        "api.open-meteo.com http 503",
        {
          level: "error",
          fingerprint: ["api", "api.open-meteo.com", "http 503"],
          tags: {
            api_host: "api.open-meteo.com",
            api_kind: "http 503",
            stage: "response",
            visibility: "visible",
          },
          extra: { path: "/v1/forecast", elapsed_ms: 250, earlier_ok: 0, url_length: 100 },
        },
      ],
    ]);
  });
  it("tagsABodyFailureWithItsStage", () => {
    const { calls, report } = setup();
    report(requestReport(rejection(new TypeError("terminated"), "body")));
    expect(calls[0]![1]).toMatchObject({ tags: { stage: "body", api_kind: "TypeError" } });
  });
  it("leavesOutTheConnectionWhenTheBrowserHasNone", () => {
    const { calls, report } = setup();
    report(requestReport({ status: 503 }));
    const options = calls[0]![1] as { tags: Record<string, string> };
    expect(options.tags).not.toHaveProperty("connection");
  });
  it("leavesOutTheMessageWhenThereIsNone", () => {
    const { calls, report } = setup();
    report(requestReport(rejection("boom")));
    const options = calls[0]![1] as { extra: Record<string, unknown> };
    expect(options.extra).not.toHaveProperty("error_message");
  });
  it("redactsTheErrorMessage", () => {
    const { calls, report } = setup();
    report(requestReport(rejection(new TypeError("bad https://x.test/?q=boulder"))));
    expect(calls[0]![1]).toMatchObject({ extra: { error_message: "bad <redacted>" } });
  });
  it("reportsHiddenWhenTheTrackerSaysSo", () => {
    const { calls, state, report } = setup();
    state.hidden = true;
    report(requestReport({ status: 503 }));
    expect(calls[0]![1]).toMatchObject({ tags: { visibility: "hidden" } });
  });
  it("reportsHiddenWhenThePageIsHiddenNow", () => {
    const { calls, state, report } = setup();
    state.hiddenNow = true;
    report(requestReport({ status: 503 }));
    expect(calls[0]![1]).toMatchObject({ tags: { visibility: "hidden" } });
  });
  it("roundsTheUrlLengthUpToTheNext100", () => {
    const { calls, report } = setup();
    const base = "https://x.test/v1/forecast?q=";
    // Each length is a different status, so none is dropped as a repeat.
    const cases: Array<[number, number, number]> = [
      [base.length + 1, 500, 100],
      [100, 501, 100],
      [101, 502, 200],
    ];
    for (const [length, status] of cases) {
      report(requestReport({ status }, { url: base + "a".repeat(length - base.length) }));
    }
    const lengths = calls.map(([, o]) => (o as { extra: { url_length: number } }).extra.url_length);
    expect(lengths).toEqual(cases.map(([, , rounded]) => rounded));
  });
  it("ignoresSuccess", () => {
    const { calls, report } = setup();
    report(requestReport({ status: 200 }));
    expect(calls).toEqual([]);
  });
  it("ignoresARepeat", () => {
    const { calls, report } = setup();
    report(requestReport({ status: 503 }));
    report(requestReport({ status: 503 }));
    expect(calls).toHaveLength(1);
  });
  it("ignoresFailuresWhileOffline", () => {
    const { calls, report } = setup(false);
    report(requestReport(rejection(new TypeError("Failed to fetch"))));
    expect(calls).toEqual([]);
  });
  it("reportsAFailureFirstSeenOfflineOnceBackOnline", () => {
    const { calls, state, report } = setup(false);
    report(requestReport({ status: 503 }));
    state.online = true;
    report(requestReport({ status: 503 }));
    expect(calls).toHaveLength(1);
  });
  it("capturesTwoKindsOnOneHost", () => {
    const { calls, report } = setup();
    report(requestReport({ status: 503 }));
    report(requestReport(rejection(new TypeError("Failed to fetch"))));
    expect(calls).toHaveLength(2);
  });
  it("countsOnlyTheSameHostsSuccessesAsEarlierOk", () => {
    const { calls, report } = setup();
    report(requestReport({ status: 200 }));
    report(requestReport({ status: 204 }));
    report(requestReport({ status: 200 }, { url: "https://router.project-osrm.org/route/v1/x" }));
    report(requestReport({ status: 404 }));
    report(requestReport({ status: 302 }));
    report(requestReport(rejection(new TypeError("Failed to fetch"))));
    expect(calls.at(-1)![1]).toMatchObject({ extra: { earlier_ok: 2 } });
    expect(calls).toHaveLength(3);
  });
  it("countsASuccessThatArrivedWhileOffline", () => {
    const { calls, state, report } = setup(false);
    report(requestReport({ status: 200 }));
    state.online = true;
    report(requestReport(rejection(new TypeError("Failed to fetch"))));
    expect(calls[0]![1]).toMatchObject({ extra: { earlier_ok: 1 } });
  });
  it("doesNotCountASuccessThatCameAfterTheReportedFailure", () => {
    const { calls, report } = setup();
    report(requestReport({ status: 503 }));
    report(requestReport({ status: 200 }));
    expect(calls[0]![1]).toMatchObject({ extra: { earlier_ok: 0 } });
  });
});
