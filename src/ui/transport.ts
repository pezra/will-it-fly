import type { Transport } from "../core/forecast/openMeteoClient";
import type { RequestReport } from "./errorReporting";

/** How long a request waits for its response headers before giving up. */
export const REQUEST_HEADERS_TIMEOUT_MS = 5_000;
/** How long reading a response body may take once its headers have arrived. */
export const REQUEST_BODY_TIMEOUT_MS = 20_000;

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
 * `fetch` that gives up after `headersMs` without response headers, and after `bodyMs` of reading
 * the body once they have arrived. Each limit aborts the request's one signal with a
 * `TimeoutError`, which rejects whichever read is pending and counts as a fetch failure.
 */
export function fetchTransportWithTimeouts({
  headersMs,
  bodyMs,
}: {
  headersMs: number;
  bodyMs: number;
}): Transport {
  const timeoutAfter = (controller: AbortController, ms: number) =>
    setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), ms);
  const fetcher: Fetcher = async (url) => {
    const controller = new AbortController();
    const headersTimer = timeoutAfter(controller, headersMs);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(headersTimer);
    }
    return {
      status: response.status,
      text: async () => {
        const bodyTimer = timeoutAfter(controller, bodyMs);
        try {
          return await response.text();
        } finally {
          clearTimeout(bodyTimer);
        }
      },
    };
  };
  return reportingTransport(fetcher, () => requestListener);
}

/** `fetch` that waits 5 s for the headers and 20 s for the body. */
export const fetchTransport: Transport = fetchTransportWithTimeouts({
  headersMs: REQUEST_HEADERS_TIMEOUT_MS,
  bodyMs: REQUEST_BODY_TIMEOUT_MS,
});
