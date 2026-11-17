// Checks what the fake Sentry received. Usage: node check.mjs <events-file> <raw-file>
// Exits 1 if any assertion fails.
import { readFileSync } from "node:fs";

const [eventsFile, rawFile] = process.argv.slice(2);
const raw = readFileSync(rawFile, "utf8");
const events = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

// Set E2E_SHOW=1 to print the first Open-Meteo API event.
if (process.env.E2E_SHOW) console.log(JSON.stringify(events.find((e) => e.tags?.api_host === "api.open-meteo.com"), null, 1));

const messageOf = (e) => e.message ?? e.exception?.values?.[0]?.value ?? "";
const apiEvents = events.filter((e) => e.fingerprint?.[0] === "api");
const byHost = (host) => apiEvents.filter((e) => e.tags?.api_host === host);
const meteo = byHost("api.open-meteo.com");
const osrm = byHost("router.project-osrm.org");
const handled = events.filter((e) => e.exception && e.fingerprint?.[0] !== "api" && !/^e2e-/.test(messageOf(e)));

check("one Open-Meteo API event", meteo.length === 1, `got ${meteo.length}`);
check("one OSRM API event", osrm.length === 1, `got ${osrm.length}`);
check("API events are kind TypeError", [...meteo, ...osrm].every((e) => e.tags?.api_kind === "TypeError"));
check("OSRM path is /table/v1/driving", osrm[0]?.extra?.path === "/table/v1/driving", String(osrm[0]?.extra?.path));
check("at most one handled exception", handled.length <= 1, `got ${handled.length}`);
check("uncaught error reported", events.some((e) => messageOf(e).includes("e2e-uncaught")));
check("unhandled rejection reported", events.some((e) => messageOf(e).includes("e2e-rejection")));
check("25 events, burst capped", events.length === 25 && !events.some((e) => messageOf(e).includes("e2e-burst-29")), `got ${events.length}`);
check("release is e2e on every event", events.every((e) => e.release === "e2e"));
check("no user", events.every((e) => !("user" in e)));
check("no breadcrumbs", events.every((e) => !e.breadcrumbs?.length));
check(
  "request headers filtered",
  events.every((e) => Object.entries(e.request?.headers ?? {}).every(([k, v]) => k === "User-Agent" || v === "[Filtered]")),
);
check("no query string in request.url", events.every((e) => !(e.request?.url ?? "").split("#")[0].includes("?")));
check("page query never appears", !raw.includes("pagequery"));
check("no cookies", events.every((e) => !e.request?.cookies && !("Cookie" in (e.request?.headers ?? {}))));
check("no coordinates in the raw log", !/-?\d+\.\d+,-?\d+\.\d+/.test(raw) && !/latitude=|longitude=/.test(raw));

// The detail added to API-failure events.
for (const [name, e] of [["Open-Meteo", meteo[0]], ["OSRM", osrm[0]]]) {
  if (!e) continue;
  const { tags = {}, extra = {} } = e;
  check(`${name}: stage is request`, tags.stage === "request", String(tags.stage));
  check(`${name}: visibility is visible`, tags.visibility === "visible", String(tags.visibility));
  check(`${name}: connection absent or a string`, tags.connection === undefined || typeof tags.connection === "string");
  check(`${name}: elapsed_ms is a number`, typeof extra.elapsed_ms === "number", String(extra.elapsed_ms));
  check(`${name}: earlier_ok is a number`, typeof extra.earlier_ok === "number", String(extra.earlier_ok));
  check(
    `${name}: url_length is a multiple of 100`,
    typeof extra.url_length === "number" && extra.url_length % 100 === 0,
    String(extra.url_length),
  );
  const m = extra.error_message;
  check(
    `${name}: error_message present and clean`,
    typeof m === "string" && m !== "" && !/:\/\/|\?|\d+\.\d+|-?\d+,-?\d+/.test(m),
    JSON.stringify(m),
  );
}

if (failed > 0) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("all assertions passed");
