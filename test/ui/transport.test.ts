import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchTransportWithTimeout,
  reportingTransport,
  setRequestListener,
  type Fetcher,
  type RequestListener,
} from "../../src/ui/transport";

afterEach(() => {
  vi.unstubAllGlobals();
  setRequestListener(undefined);
});

/** A `fetch` that never answers and rejects with the signal's reason once it aborts. */
function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
}

describe("fetchTransportWithTimeout", () => {
  it("returnsTheStatusAndBody", async () => {
    const stub = vi.fn<typeof fetch>(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", stub);
    const response = await fetchTransportWithTimeout(1_000)("https://example.com/x");
    expect(response).toEqual({ status: 503, body: "busy" });
    expect(stub.mock.calls[0]![0]).toBe("https://example.com/x");
    expect(stub.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("abortsAfterTheTimeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const started = Date.now();
    await expect(fetchTransportWithTimeout(20)("https://example.com/slow")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("eachRequestGetsItsOwnTimeout", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        signals.push(init?.signal);
        return new Response("");
      }),
    );
    const transport = fetchTransportWithTimeout(1_000);
    await transport("https://example.com/1");
    await transport("https://example.com/2");
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((s) => s?.aborted === false)).toBe(true);
  });
});

describe("reportingTransport", () => {
  const url = "https://example.com/x";
  const answering =
    (status: number, body: string): Fetcher =>
    async () => ({ status, text: async () => body });
  const rejecting =
    (error: unknown): Fetcher =>
    async () => {
      throw error;
    };
  /** A clock that returns each of `times` in turn. */
  const clock = (...times: number[]) => {
    const queue = [...times];
    return () => queue.shift()!;
  };

  it("reportsA2xxAndReturnsTheResponse", async () => {
    const listener = vi.fn<RequestListener>();
    const response = await reportingTransport(answering(200, "ok"), () => listener, clock(1, 2))(url);
    expect(response).toEqual({ status: 200, body: "ok" });
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      url,
      startedAt: 1,
      endedAt: 2,
      outcome: { status: 200 },
    });
  });

  it("reportsANon2xxStatusAndReturnsTheResponse", async () => {
    const listener = vi.fn<RequestListener>();
    const response = await reportingTransport(answering(503, "busy"), () => listener)(url);
    expect(response).toEqual({ status: 503, body: "busy" });
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url, outcome: { status: 503 } }),
    );
  });

  it("reportsARejectionAtTheRequestStageAndRethrowsTheSameError", async () => {
    const listener = vi.fn<RequestListener>();
    const failure = new TypeError("Failed to fetch");
    const caught = await reportingTransport(rejecting(failure), () => listener, clock(10, 35))(url).catch(
      (e: unknown) => e,
    );
    expect(caught).toBe(failure);
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      url,
      startedAt: 10,
      endedAt: 35,
      outcome: { error: failure, stage: "request" },
    });
  });

  it("reportsABodyFailureAtTheBodyStageAndRethrowsTheSameError", async () => {
    const listener = vi.fn<RequestListener>();
    const failure = new TypeError("terminated");
    const fetcher: Fetcher = async () => ({
      status: 200,
      text: async () => {
        throw failure;
      },
    });
    const caught = await reportingTransport(fetcher, () => listener, clock(5, 9))(url).catch(
      (e: unknown) => e,
    );
    expect(caught).toBe(failure);
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      url,
      startedAt: 5,
      endedAt: 9,
      outcome: { error: failure, stage: "body", status: 200 },
    });
  });

  it("takesTheStartTimeBeforeTheRequestAndTheEndTimeAfterTheBody", async () => {
    const listener = vi.fn<RequestListener>();
    const events: string[] = [];
    const fetcher: Fetcher = async () => {
      events.push("fetch");
      return {
        status: 200,
        text: async () => {
          events.push("text");
          return "";
        },
      };
    };
    const now = () => {
      events.push("now");
      return events.length;
    };
    await reportingTransport(fetcher, () => listener, now)(url);
    expect(events).toEqual(["now", "fetch", "text", "now"]);
  });

  it("aThrowingListenerChangesNothingForTheCaller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const listener: RequestListener = () => {
        throw new Error("listener broke");
      };
      const failure = new Error("down");
      const ok = reportingTransport(answering(500, "x"), () => listener);
      expect(await ok(url)).toEqual({ status: 500, body: "x" });
      const bad = reportingTransport(rejecting(failure), () => listener);
      expect(await bad(url).catch((e: unknown) => e)).toBe(failure);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("anUndefinedListenerIsANoOp", async () => {
    const failure = new Error("down");
    const bad = reportingTransport(rejecting(failure), () => undefined);
    expect(await bad(url).catch((e: unknown) => e)).toBe(failure);
    const busy = reportingTransport(answering(503, ""), () => undefined);
    expect(await busy(url)).toEqual({ status: 503, body: "" });
  });
});

describe("fetchTransportWithTimeout reporting", () => {
  it("reportsANon2xxStatusToTheCurrentListener", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("busy", { status: 503 })));
    const transport = fetchTransportWithTimeout(1_000);
    const spy = vi.fn<RequestListener>();
    setRequestListener(spy);
    await transport("https://example.com/x");
    expect(spy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: "https://example.com/x", outcome: { status: 503 } }),
    );
  });

  it("reportsATimeoutWithATimeoutError", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const spy = vi.fn<RequestListener>();
    setRequestListener(spy);
    await expect(fetchTransportWithTimeout(20)("https://example.com/slow")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].outcome).toMatchObject({
      error: { name: "TimeoutError" },
      stage: "request",
    });
  });
});
