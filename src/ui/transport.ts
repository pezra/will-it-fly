import type { Transport } from "../core/forecast/openMeteoClient";
import type { RequestReport } from "./errorReporting";

export const REQUEST_TIMEOUT_MS = 20_000;

export type RequestListener = (report: RequestReport) => void;

/** A thin `fetch`: the status arrives first, and the body is read separately. */
export type Fetcher = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

let requestListener: RequestListener | undefined;

/** Sets who hears about requests. Read on each report, so it can be set after the transports exist. */
export function setRequestListener(fn: RequestListener | undefined): void {
  requestListener = fn;
}

/**
 * Tells the current listener how every request ended, with its timing and the stage a rejection
 * came at, then gives the caller exactly what `fetcher` produced. The listener decides what counts
 * as a failure. A listener that throws is logged and ignored.
 */
export function reportingTransport(
  fetcher: Fetcher,
  onReport: () => RequestListener | undefined,
  now: () => number = () => performance.now(),
): Transport {
  return async (url) => {
    const startedAt = now();
    const notify = (outcome: RequestReport["outcome"]) => {
      try {
        onReport()?.({ url, startedAt, endedAt: now(), outcome });
      } catch (e) {
        console.warn("Could not report a request", e);
      }
    };
    let response;
    try {
      response = await fetcher(url);
    } catch (error) {
      notify({ error, stage: "request" });
      throw error;
    }
    let body;
    try {
      body = await response.text();
    } catch (error) {
      notify({ error, stage: "body", status: response.status });
      throw error;
    }
    notify({ status: response.status });
    return { status: response.status, body };
  };
}

/**
 * `fetch` with a timeout of `ms` per request. A timeout or network error rejects, which counts as a
 * fetch failure.
 */
export function fetchTransportWithTimeout(ms: number): Transport {
  return reportingTransport(
    (url) => fetch(url, { signal: AbortSignal.timeout(ms) }),
    () => requestListener,
  );
}

/** `fetch` with a 20 s timeout. */
export const fetchTransport: Transport = fetchTransportWithTimeout(REQUEST_TIMEOUT_MS);
