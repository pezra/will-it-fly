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

/**
 * How a request ended: a status arrived, or a rejection at the request, or a rejection while reading
 * the body of a response whose status had arrived.
 */
export type ApiOutcome =
  | { status: number }
  | { error: unknown; stage: "request" }
  | { error: unknown; stage: "body"; status: number };
/** Times are `performance.now()` milliseconds. */
export type RequestReport = { url: string; startedAt: number; endedAt: number; outcome: ApiOutcome };
export type ApiFailure = { host: string; path: string; kind: string };

const PATH_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const UNSAFE_WORD = /[\d/?=&:@]/;
const MAX_MESSAGE_LENGTH = 200;

/** The error's name if it is a plain identifier, otherwise `unknown`. Reads any object: DOMException is not always an Error. */
export function errorKind(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && ERROR_NAME.test(name) ? name : "unknown";
}

/**
 * The error's message with every whitespace-separated word that has a digit or any of `/ ? = & : @`
 * replaced by `<redacted>`, cut to 200 characters. A fetch error can quote its URL, and those hold
 * coordinates and search text. Undefined when there is no message to send.
 */
export function redactMessage(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string" || message.trim() === "") return undefined;
  return message
    .replace(/\S+/g, (word) => (UNSAFE_WORD.test(word) ? "<redacted>" : word))
    .slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Remembers when the page was last hidden and last shown, to tell whether it was hidden at any time
 * since a request started. Asked at failure time the rule is exact, because every earlier hidden
 * interval ended before the last one began. Whether it is hidden right now is the caller's to read.
 * Times share a clock with the requests'.
 */
export function createVisibilityTracker(): {
  hidden: (at: number) => void;
  visible: (at: number) => void;
  hiddenBetween: (start: number) => boolean;
} {
  let lastHidden = -Infinity;
  let lastVisible = -Infinity;
  return {
    hidden: (at) => {
      lastHidden = at;
    },
    visible: (at) => {
      lastVisible = at;
    },
    // Went hidden after the start, or came back after it (so it was hidden at the start).
    hiddenBetween: (start) => lastHidden >= start || lastVisible > start,
  };
}

/**
 * What to report about a finished request, or undefined if it succeeded. The path keeps only the
 * leading words of the pathname, so coordinates and search text never leave the device.
 * Throws on an unparseable URL; the transport guards its listener.
 */
export function apiFailure(url: string, outcome: ApiOutcome): ApiFailure | undefined {
  let kind: string;
  if ("error" in outcome) {
    kind = errorKind(outcome.error);
  } else {
    if (isSuccess(outcome.status)) return undefined;
    kind = `http ${outcome.status}`;
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

/** Calls `fn` the first time only; later calls do nothing. */
export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
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
  extra: Record<string, string | number>;
}

export function makeApiFailureReporter(deps: {
  capture: (message: string, options: CaptureOptions) => void;
  isOnline: () => boolean;
  /** The connection's effective type, where the browser has one. */
  connection: () => string | undefined;
  /** Whether the page was hidden at any time since `start`. */
  hiddenBetween: (start: number) => boolean;
  hiddenNow: () => boolean;
}): (report: RequestReport) => void {
  const shouldReport = createApiFailureFilter();
  const okByHost = new Map<string, number>();
  return ({ url, startedAt, endedAt, outcome }) => {
    // Successes are counted before the offline and repeat checks, so the count covers them all.
    if (!("error" in outcome) && isSuccess(outcome.status)) {
      const host = new URL(url).host;
      okByHost.set(host, (okByHost.get(host) ?? 0) + 1);
      return;
    }
    const failure = apiFailure(url, outcome);
    // Offline is checked first, so a failure seen offline is still reported once back online.
    if (!failure || !deps.isOnline() || !shouldReport(failure)) return;
    const { host, path, kind } = failure;
    const tags: Record<string, string> = {
      api_host: host,
      api_kind: kind,
      stage: "error" in outcome ? outcome.stage : "response",
      // Also read now, in case the rejection fires before `visibilitychange` is delivered.
      visibility: deps.hiddenNow() || deps.hiddenBetween(startedAt) ? "hidden" : "visible",
    };
    const connection = deps.connection();
    if (connection !== undefined) tags.connection = connection;
    const extra: Record<string, string | number> = {
      path,
      elapsed_ms: Math.round(endedAt - startedAt),
      earlier_ok: okByHost.get(host) ?? 0,
      // Rounded up, so a search query's length is not given away.
      url_length: Math.ceil(url.length / 100) * 100,
    };
    if ("error" in outcome) {
      const message = redactMessage(outcome.error);
      if (message !== undefined) extra.error_message = message;
      // A body that failed after a status arrived keeps the status, so a server error still shows.
      if (outcome.stage === "body") extra.http_status = outcome.status;
    }
    deps.capture(`${host} ${kind}`, { level: "error", fingerprint: ["api", host, kind], tags, extra });
  };
}
