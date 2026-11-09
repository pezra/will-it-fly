import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTransportWithTimeout } from "../../src/ui/transport";

afterEach(() => vi.unstubAllGlobals());

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
