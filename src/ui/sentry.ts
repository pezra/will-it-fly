import * as Sentry from "@sentry/browser";
import {
  MAX_EVENTS_PER_LOAD,
  createEventCap,
  makeApiFailureReporter,
  makeBeforeSend,
  reportingEnabled,
} from "./errorReporting";
import { setApiFailureListener } from "./transport";

/** A DSN is public by design. Sentry's Allowed Domains setting keeps other sites from using it. */
const SENTRY_DSN =
  "https://cc98d3f489b509b442aa241b49b1b77b@o4512448280199168.ingest.us.sentry.io/4512448291667968";

/** A build-time `VITE_SENTRY_DSN` replaces the constant. Empty turns reporting off. */
const dsn = import.meta.env.VITE_SENTRY_DSN ?? SENTRY_DSN;

let reporting = false;

/**
 * Starts the error tracker, but only in a production build served from a real host. Otherwise
 * nothing is initialized and nothing is sent. Only the integrations listed here are installed, so
 * there is no breadcrumb, console, fetch or tracing instrumentation.
 */
export function initErrorReporting(): void {
  if (!reportingEnabled({ prod: import.meta.env.PROD, hostname: location.hostname, dsn })) return;
  try {
    Sentry.init({
      dsn,
      release: import.meta.env.VITE_RELEASE || undefined,
      environment: "production",
      dataCollection: {
        userInfo: false,
        cookies: false,
        urlQueryParams: false,
        httpHeaders: { request: { allow: ["user-agent"] }, response: false },
      },
      defaultIntegrations: false,
      integrations: [
        Sentry.globalHandlersIntegration(),
        Sentry.linkedErrorsIntegration(),
        Sentry.dedupeIntegration(),
        Sentry.httpContextIntegration(),
        Sentry.eventFiltersIntegration(),
      ],
      beforeSend: makeBeforeSend(createEventCap(MAX_EVENTS_PER_LOAD)),
    });
    reporting = true;
    setApiFailureListener(
      makeApiFailureReporter({
        capture: (message, options) => Sentry.captureMessage(message, options),
        isOnline: () => navigator.onLine,
      }),
    );
  } catch (error) {
    console.warn("Error reporting failed to start", error);
  }
}

/** Whether errors are going to the tracker, for telling the user so. */
export function isReporting(): boolean {
  return reporting;
}

export function reportError(error: unknown): void {
  if (reporting) Sentry.captureException(error);
}
