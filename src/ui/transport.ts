import type { Transport } from "../core/forecast/openMeteoClient";

export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `fetch` with a timeout of `ms` per request. A timeout or network error rejects, which counts as a
 * fetch failure.
 */
export function fetchTransportWithTimeout(ms: number): Transport {
  return async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: response.status, body: await response.text() };
  };
}

/** `fetch` with a 20 s timeout. */
export const fetchTransport: Transport = fetchTransportWithTimeout(REQUEST_TIMEOUT_MS);
