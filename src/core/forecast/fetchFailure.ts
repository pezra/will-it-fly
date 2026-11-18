import { OpenMeteoError } from "./openMeteoClient";

/** Why a forecast fetch failed, as far as what the user can do about it. */
export type FetchFailureKind = "network" | "rateLimited" | "server" | "other";

const NETWORK_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "TypeError"]);

/**
 * Sorts a fetch error into a kind. A 429 is `rateLimited`, a 5xx is `server`, a timeout or fetch
 * failure is `network`; every other error, including a malformed response, is `other`.
 */
export function fetchFailureKind(error: unknown): FetchFailureKind {
  if (error instanceof OpenMeteoError) {
    if (error.kind === "http" && error.status !== undefined) {
      if (error.status === 429) return "rateLimited";
      if (error.status >= 500) return "server";
    }
    return "other";
  }
  // Read the name off any object: DOMException is not always an Error.
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && NETWORK_ERROR_NAMES.has(name) ? "network" : "other";
}
