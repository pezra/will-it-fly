/**
 * The rules for what gets reported to the error tracker. Pure functions with no SDK and no browser
 * globals, so they run in node tests. `sentry.ts` wires them to the SDK.
 */

export const MAX_EVENTS_PER_LOAD = 25;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

export function reportingEnabled(opts: { prod: boolean; hostname: string; dsn: string }): boolean {
  return opts.prod && !isLocalHost(opts.hostname) && opts.dsn !== "";
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

export type ApiOutcome = { status: number } | { error: unknown };
export type ApiFailure = { host: string; path: string; kind: string };

const PATH_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * What to report about a finished request, or undefined if it succeeded. The path keeps only the
 * leading words of the pathname, so coordinates and search text never leave the device.
 * Throws on an unparseable URL; the transport guards its listener.
 */
export function apiFailure(url: string, outcome: ApiOutcome): ApiFailure | undefined {
  let kind: string;
  if ("status" in outcome) {
    if (isSuccess(outcome.status)) return undefined;
    kind = `http ${outcome.status}`;
  } else {
    // Read off any object: DOMException is not always an Error, depending on the runtime.
    const name = (outcome.error as { name?: unknown } | null | undefined)?.name;
    kind = name === "TimeoutError" ? "timeout" : "network";
  }

  const parsed = new URL(url);
  const words: string[] = [];
  for (const segment of parsed.pathname.split("/").slice(1)) {
    if (!PATH_WORD.test(segment)) break;
    words.push(segment);
  }
  return { host: parsed.host, path: "/" + words.join("/"), kind };
}


/** Passes each host and kind of failure once per page load. */
export function createApiFailureFilter(): (failure: ApiFailure) => boolean {
  const seen = new Set<string>();
  return (failure) => {
    const key = `${failure.host} ${failure.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

export function createEventCap(max: number): () => boolean {
  let count = 0;
  return () => count++ < max;
}

/** Drops events once the cap is used up. The SDK's `urlQueryParams: false` already strips page queries. */
export function makeBeforeSend(cap: () => boolean): <E>(event: E) => E | null {
  return (event) => (cap() ? event : null);
}

interface CaptureOptions {
  level: "error";
  fingerprint: string[];
  tags: Record<string, string>;
  extra: Record<string, string>;
}

export function makeApiFailureReporter(deps: {
  capture: (message: string, options: CaptureOptions) => void;
  isOnline: () => boolean;
}): (url: string, outcome: ApiOutcome) => void {
  const shouldReport = createApiFailureFilter();
  return (url, outcome) => {
    const failure = apiFailure(url, outcome);
    // Offline is checked first, so a failure seen offline is still reported once back online.
    if (!failure || !deps.isOnline() || !shouldReport(failure)) return;
    const { host, path, kind } = failure;
    deps.capture(`${host} ${kind}`, {
      level: "error",
      fingerprint: ["api", host, kind],
      tags: { api_host: host, api_kind: kind },
      extra: { path },
    });
  };
}
