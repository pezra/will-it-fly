import type { Transport } from "../core/forecast/openMeteoClient";

export const REQUEST_TIMEOUT_MS = 20_000;

/** `fetch` with a 20 s timeout. A timeout or network error rejects, which counts as a fetch failure. */
export const fetchTransport: Transport = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { status: response.status, body: await response.text() };
};
