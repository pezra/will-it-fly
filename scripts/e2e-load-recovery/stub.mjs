// Stub Open-Meteo (and a dead OSRM) for checking the app's failure handling by hand.
//   node stub.mjs <mode> [port]     modes: ok, 429, 503, hang-once, hang
// driver.mjs imports startStub() and runs it in-process.
//
// Modes (for /v1/forecast):
//   ok         answers every request with a synthesized, valid forecast
//   429        answers 429 with Open-Meteo's JSON error body
//   503        answers 503
//   hang-once  the FIRST request of each kind (surface, levels, neighbors) never answers
//              (socket kept open); every later request is answered like `ok`
//   hang       every request never answers
// OSRM (/table/...) always answers 500, so the app falls back to estimated drive times.
// Valid bodies are built from the recorded fixtures in test/fixtures, repeated for however many
// locations the URL asks for and shifted so the first hour is local midnight of the requested day.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");
const read = (name) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

const DENVER_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Epoch seconds of local midnight in Denver on `day` (YYYY-MM-DD). */
function denverMidnight(day) {
  const [y, m, d] = day.split("-").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Denver is 6 or 7 hours behind UTC; take whichever offset makes the local date and hour 00:00.
  for (const hours of [6, 7]) {
    const t = utcGuess + hours * 3600_000;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Denver", hour: "2-digit", hourCycle: "h23",
    }).format(new Date(t));
    if (parts === "00" && DENVER_DAY.format(new Date(t)) === day) return t / 1000;
  }
  throw new Error(`no Denver midnight for ${day}`);
}

/** surface (has `cape`), levels (pressure-level variables) or neighbors (10 m wind only). */
function kindOf(query) {
  const hourly = query.get("hourly");
  return hourly.includes("cape") ? "surface" : hourly.includes("hPa") ? "levels" : "neighbors";
}

function synthesize(url) {
  const query = url.searchParams;
  const count = query.get("latitude").split(",").length;
  const source = read(`openmeteo-${kindOf(query)}.json`);
  const day = query.get("start_date") ?? DENVER_DAY.format(new Date());
  const days = query.get("start_date") ? 1 : Number(query.get("forecast_days") ?? 2);
  const shift = denverMidnight(day) - source[0].hourly.time[0];
  const locations = Array.from({ length: count }, (_, i) => {
    const loc = structuredClone(source[i % source.length]);
    for (const part of [loc.hourly, loc.daily]) {
      if (!part) continue; // levels has no daily
      const length = part === loc.hourly ? days * 24 : days;
      for (const [key, series] of Object.entries(part)) {
        const isTime = key === "time" || key.startsWith("sunrise") || key.startsWith("sunset");
        part[key] = series.slice(0, length).map((v) => (isTime && v !== null ? v + shift : v));
      }
    }
    return loc;
  });
  return count === 1 ? locations[0] : locations;
}

export async function startStub({ mode, port = 0, log = () => {} }) {
  const requests = []; // { t, kind, url, outcome }
  const open = new Set();
  const hungKinds = new Set();
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url, "http://stub");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.writeHead(204).end();
      return;
    }
    const t = Date.now();
    if (url.pathname.startsWith("/table/")) {
      requests.push({ t, kind: "osrm", outcome: "500" });
      res.writeHead(500).end("no routing here");
      return;
    }
    if (url.pathname !== "/v1/forecast") {
      res.writeHead(404).end();
      return;
    }
    const kind = kindOf(url.searchParams);
    const entry = { t, kind, outcome: "" };
    requests.push(entry);
    const hang = () => {
      entry.outcome = "hang";
      open.add(res);
      res.on("close", () => {
        open.delete(res);
        entry.closedAt = Date.now();
      });
      // No writeHead: the client gets no headers until it gives up.
    };
    if (mode === "hang" || (mode === "hang-once" && !hungKinds.has(kind))) {
      hungKinds.add(kind);
      hang();
    } else if (mode === "429") {
      entry.outcome = "429";
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: true, reason: "Too many concurrent requests (stub)" }));
    } else if (mode === "503") {
      entry.outcome = "503";
      res.writeHead(503, { "content-type": "text/plain" }).end("Service Unavailable (stub)");
    } else {
      entry.outcome = "200";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(synthesize(url)));
    }
    log(`${mode} ${kind} -> ${entry.outcome}`);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    forecastRequests: () => requests.filter((r) => r.kind !== "osrm"),
    close: () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode = "ok", port = "0"] = process.argv.slice(2);
  const stub = await startStub({ mode, port: Number(port), log: console.log });
  console.log(`stub (${mode}) on http://127.0.0.1:${stub.port}`);
  process.on("SIGINT", () => stub.close().then(() => process.exit(0)));
}
