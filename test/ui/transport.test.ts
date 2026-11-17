import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "../../src/core/forecast/openMeteoClient";
import {
  fetchTransportWithTimeout,
  reportingTransport,
  setApiFailureListener,
  type FailureListener,
} from "../../src/ui/transport";

afterEach(() => {
  vi.unstubAllGlobals();
  setApiFailureListener(undefined);
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

  it("doesNotReportASuccessfulResponse", async () => {
    const listener = vi.fn<FailureListener>();
    const inner: Transport = async () => ({ status: 200, body: "ok" });
    const response = await reportingTransport(inner, () => listener)(url);
    expect(response).toEqual({ status: 200, body: "ok" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("reportsANon2xxStatusAndReturnsTheResponse", async () => {
    const listener = vi.fn<FailureListener>();
    const inner: Transport = async () => ({ status: 503, body: "busy" });
    const response = await reportingTransport(inner, () => listener)(url);
    expect(response).toEqual({ status: 503, body: "busy" });
    expect(listener).toHaveBeenCalledExactlyOnceWith(url, { status: 503 });
  });

  it("reportsARejectionAndRethrowsTheSameError", async () => {
    const listener = vi.fn<FailureListener>();
    const failure = new TypeError("Failed to fetch");
    const inner: Transport = async () => {
      throw failure;
    };
    const caught = await reportingTransport(inner, () => listener)(url).catch((e: unknown) => e);
    expect(caught).toBe(failure);
    expect(listener).toHaveBeenCalledExactlyOnceWith(url, { error: failure });
  });

  it("aThrowingListenerChangesNothingForTheCaller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const listener: FailureListener = () => {
        throw new Error("listener broke");
      };
      const failure = new Error("down");
      const ok = reportingTransport(async () => ({ status: 500, body: "x" }), () => listener);
      expect(await ok(url)).toEqual({ status: 500, body: "x" });
      const bad = reportingTransport(
        async () => {
          throw failure;
        },
        () => listener,
      );
      expect(await bad(url).catch((e: unknown) => e)).toBe(failure);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("anUndefinedListenerIsANoOp", async () => {
    const failure = new Error("down");
    const bad = reportingTransport(
      async () => {
        throw failure;
      },
      () => undefined,
    );
    expect(await bad(url).catch((e: unknown) => e)).toBe(failure);
    const busy = reportingTransport(async () => ({ status: 503, body: "" }), () => undefined);
    expect(await busy(url)).toEqual({ status: 503, body: "" });
  });
});

describe("fetchTransportWithTimeout reporting", () => {
  it("reportsANon2xxStatusToTheCurrentListener", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("busy", { status: 503 })));
    const transport = fetchTransportWithTimeout(1_000);
    const spy = vi.fn<FailureListener>();
    setApiFailureListener(spy);
    await transport("https://example.com/x");
    expect(spy).toHaveBeenCalledExactlyOnceWith("https://example.com/x", { status: 503 });
  });

  it("reportsATimeoutWithATimeoutError", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const spy = vi.fn<FailureListener>();
    setApiFailureListener(spy);
    await expect(fetchTransportWithTimeout(20)("https://example.com/slow")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toMatchObject({ error: { name: "TimeoutError" } });
  });
});
