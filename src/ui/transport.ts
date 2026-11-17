import type { Transport } from "../core/forecast/openMeteoClient";
import type { ApiOutcome } from "./errorReporting";

export const REQUEST_TIMEOUT_MS = 20_000;

export type FailureListener = (url: string, outcome: ApiOutcome) => void;

let apiFailureListener: FailureListener | undefined;

/** Sets who hears about failed requests. Read on each failure, so it can be set after the transports exist. */
export function setApiFailureListener(fn: FailureListener | undefined): void {
  apiFailureListener = fn;
}

/**
 * Tells the current listener about non-2xx responses and rejections, then gives the caller exactly
 * what `inner` produced. A listener that throws is logged and ignored.
 */
export function reportingTransport(
  inner: Transport,
  onFailure: () => FailureListener | undefined,
): Transport {
  const notify = (url: string, outcome: ApiOutcome) => {
    try {
      onFailure()?.(url, outcome);
    } catch (e) {
      console.warn("Could not report a failed request", e);
    }
  };
  return async (url) => {
    let response;
    try {
      response = await inner(url);
    } catch (error) {
      notify(url, { error });
      throw error;
    }
    if (response.status < 200 || response.status > 299) notify(url, { status: response.status });
    return response;
  };
}

/**
 * `fetch` with a timeout of `ms` per request. A timeout or network error rejects, which counts as a
 * fetch failure.
 */
export function fetchTransportWithTimeout(ms: number): Transport {
  return reportingTransport(
    async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
      return { status: response.status, body: await response.text() };
    },
    () => apiFailureListener,
  );
}

/** `fetch` with a 20 s timeout. */
export const fetchTransport: Transport = fetchTransportWithTimeout(REQUEST_TIMEOUT_MS);
