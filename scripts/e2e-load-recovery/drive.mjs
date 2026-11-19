// Checks how forecast loads recover from failures: drives the dev app in headless Chrome against a stub Open-Meteo and prints
// PASS/FAIL per check. Run from anywhere (Node 24, repo deps installed):
//   node drive.mjs [429] [503] [hang-once] [hang] [hidden]      (no arguments: all of them, ~3 min)
// Never talks to api.open-meteo.com, router.project-osrm.org or nominatim: the app is pointed at the
// stub with ?base= and ?routeBase=. Starts only: the stub (in-process), vite dev, and one headless
// Chrome per scenario, each in its own process group, and stops exactly those on exit.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const chromeBin = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Requests per load: surface, levels and neighbors, sent in parallel. A retry sends them all again.
const KINDS = 3;

const TEXT = {
  rate: "Open-Meteo, the weather service, is limiting how often the app can ask for forecasts. Try again in a minute or two.",
  server: "Open-Meteo, the weather service, is having trouble (HTTP 503). Try again shortly.",
  network: "Couldn't reach Open-Meteo. Check your connection and try again.",
};

// ---- process bookkeeping: only what this script started, by process group ----
const children = [];
const tmpDirs = [];
function start(command, args, options) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", ...options });
  children.push(child);
  return child;
}
function stopChild(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
}
const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const child of children) stopChild(child);
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

// ---- results ----
let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

// ---- CDP ----
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.id !== undefined) pending.get(data.id)?.(data);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (r) => (r.error ? reject(new Error(`${method}: ${r.error.message}`)) : resolve(r.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const run = async (expression) => {
    const { exceptionDetails, result } = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(`evaluating ${expression}: ${exceptionDetails.text}`);
    return result.value;
  };
  return { send, run, close: () => ws.close() };
}

async function launchChrome(debugPort, profile) {
  start(chromeBin, [
    "--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check", "about:blank",
  ]);
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const STORED_START = {
  start: { kind: "place", name: "e2e", coordinate: { latitude: 40.015, longitude: -105.27 } },
  maxHours: 2,
  kiteMinutes: 30,
};

/** One scenario: a fresh Chrome profile and a fresh stub. `body(ctx)` does the scenario's checks. */
async function scenario(name, mode, appPort, body) {
  console.log(`\n== ${name} (stub mode ${mode}) ==`);
  const stub = await startStub({ mode });
  const profile = mkdtemp("profile");
  const debugPort = await freePort();
  const chrome = children.length;
  const page = await launchChrome(debugPort, profile);
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem("willItFly.travel.v1", ${JSON.stringify(JSON.stringify(STORED_START))});
      window.__vis = []; document.addEventListener("visibilitychange", () => window.__vis.push([Math.round(performance.now()), document.visibilityState]));
      window.__life = [];
      window.__poll = []; setInterval(() => { const v = document.visibilityState; if (window.__poll.at(-1)?.[1] !== v) window.__poll.push([Math.round(performance.now()), v]); }, 50);
      window.__fetches = []; const realFetch = window.fetch; window.fetch = function (u, ...r) { window.__fetches.push([Math.round(performance.now()), String(u).replace(/\\?.*/, "").slice(-25), document.visibilityState]); return realFetch.call(this, u, ...r); };
      for (const type of ["freeze", "resume"]) document.addEventListener(type, () => window.__life.push([Math.round(performance.now()), type, document.visibilityState]));
      window.addEventListener("pageshow", (e) => window.__life.push([Math.round(performance.now()), "pageshow", e.persisted]));
      window.addEventListener("pagehide", (e) => window.__life.push([Math.round(performance.now()), "pagehide", e.persisted]));`,
  });
  const url = `http://127.0.0.1:${appPort}/?base=${encodeURIComponent(`http://127.0.0.1:${stub.port}`)}&routeBase=${encodeURIComponent(`http://127.0.0.1:${stub.port}`)}`;
  const t0 = Date.now();
  await cdp.send("Page.navigate", { url });

  // Sample the page every 500 ms until stopped.
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const s = await cdp.run(`({
          text: document.body.innerText,
          vis: document.visibilityState,
          buttons: [...document.querySelectorAll("button")].map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })),
        })`);
        samples.push({ t: Date.now() - t0, ...s });
      } catch {}
      await sleep(500);
    }
  })();
  const ctx = {
    cdp, stub, debugPort, samples, t0, url,
    elapsed: () => Date.now() - t0,
    last: () => samples[samples.length - 1],
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = samples.findLast(predicate);
        if (hit) return hit;
        await sleep(250);
      }
      return undefined;
    },
    firstSample: (predicate) => samples.find(predicate),
  };
  try {
    await body(ctx);
  } finally {
    sampling = false;
    await sampler;
    cdp.close();
    // Stop this scenario's Chrome now, so profiles don't pile up.
    stopChild(children[chrome]);
    await Promise.race([exited(children[chrome]), sleep(5_000)]);
    await sleep(500); // helper processes outlive the main one briefly
    await stub.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  return ctx;
}

function mkdtemp(label) {
  const dir = mkdtempSync(join(tmpdir(), `load-recovery-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

const has = (needle) => (s) => s.text.includes(needle);
const buttonMatching = (re) => (s) => s.buttons.find((b) => re.test(b.text));
const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;
const snippet = (s) => JSON.stringify(s?.text.replace(/\s+/g, " ").slice(0, 300));

// ---- scenarios ----
const scenarios = {
  async "429"(appPort) {
    await scenario("429", "429", appPort, async (c) => {
      const failed = await c.waitFor(has(TEXT.rate), 15_000);
      check("429: failed screen shows the rate-limit text", !!failed, failed ? `at ${fmt(failed.t)}` : snippet(c.last()));
      const held = await c.waitFor((s) => buttonMatching(/^Retry in 1:\d\d$/)(s)?.disabled, 3_000);
      check("429: a disabled button reads 'Retry in 1:dd'", !!held,
        held ? JSON.stringify(held.buttons) : JSON.stringify(c.last()?.buttons));
      check("429: no 'Couldn't reach' text", !c.samples.some(has("Couldn't reach")));
      const requestsAtFail = c.stub.forecastRequests().length;
      check("429: exactly one request of each kind so far (no automatic retry)",
        requestsAtFail === KINDS && new Set(c.stub.forecastRequests().map((r) => r.kind)).size === KINDS && c.stub.forecastRequests().every((r) => r.outcome === "429"),
        c.stub.forecastRequests().map((r) => `${r.kind}:${r.outcome}`).join(","));
      await sleep(5_000);
      const labels = c.samples.map((s) => buttonMatching(/^Retry in \d:\d\d$/)(s)?.text).filter(Boolean);
      const secs = labels.map((l) => Number(l.slice(-4, -3)) * 60 + Number(l.slice(-2)));
      const decreasing = secs.length > 6 && secs.every((v, i) => i === 0 || v <= secs[i - 1]) && secs[0] - secs.at(-1) >= 4;
      check("429: the label counts down", decreasing, `${labels[0]} -> ${labels.at(-1)} over ${labels.length} samples`);
      const mid = c.last();
      check("429: Refresh-style actions stay held (button still disabled mid-hold)",
        !!buttonMatching(/^Retry in/)(mid)?.disabled, JSON.stringify(mid.buttons));

      // Wait out the 90 s hold (from when the 429 landed), then the button must be enabled with no reload.
      const enabled = await c.waitFor((s) => buttonMatching(/^Retry$/)(s) && !buttonMatching(/^Retry$/)(s).disabled, 100_000);
      const heldAt = held?.t;
      check("429: after ~90 s the button is enabled and reads 'Retry'",
        !!enabled && enabled.t - heldAt > 80_000 && enabled.t - heldAt < 95_000,
        enabled ? `enabled ${fmt(enabled.t - heldAt)} after first held sample` : "never enabled");
      await sleep(3_000);
      check("429: no automatic reload when the hold ends", c.stub.forecastRequests().length === KINDS,
        `${c.stub.forecastRequests().length} forecast requests`);
      check("429: failure text still shown after the hold", c.last().text.includes(TEXT.rate));
      // Clicking Retry works again, and re-holds.
      await c.cdp.run(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Retry")?.click()`);
      await sleep(3_000);
      check("429: clicking Retry sends new requests and holds again",
        c.stub.forecastRequests().length === 2 * KINDS && !!buttonMatching(/^Retry in 1:\d\d$/)(c.last())?.disabled,
        `${c.stub.forecastRequests().length} requests; ${JSON.stringify(c.last().buttons)}`);
    });
  },

  async "503"(appPort) {
    await scenario("503", "503", appPort, async (c) => {
      const failed = await c.waitFor(has(TEXT.server), 15_000);
      check("503: failed screen shows the server text with (HTTP 503)", !!failed, failed ? `at ${fmt(failed.t)}` : snippet(c.last()));
      const b = buttonMatching(/^Retry$/)(c.last() ?? { buttons: [] });
      check("503: Retry is enabled at once", !!b && !b.disabled, JSON.stringify(c.last()?.buttons));
      await sleep(3_000);
      check(`503: no automatic retry (${KINDS} requests)`, c.stub.forecastRequests().length === KINDS,
        c.stub.forecastRequests().map((r) => `${r.kind}:${r.outcome}`).join(","));
      await c.cdp.run(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Retry")?.click()`);
      await sleep(2_500);
      check("503: clicking Retry sends new requests (not held)", c.stub.forecastRequests().length === 2 * KINDS,
        `${c.stub.forecastRequests().length} requests`);
      check("503: no 'Retry in' countdown ever shown", !c.samples.some((s) => s.buttons.some((x) => /Retry in/.test(x.text))));
    });
  },

  async "hang-once"(appPort) {
    await scenario("hang-once", "hang-once", appPort, async (c) => {
      const loaded = await c.waitFor(listLoaded, 20_000);
      check("hang-once: the list loads", !!loaded, loaded ? `at ${fmt(loaded.t)}` : snippet(c.last()));
      check("hang-once: it loaded after about 5 s (4.5 to 8 s)", !!loaded && loaded.t >= 4_500 && loaded.t <= 8_000, loaded ? fmt(loaded.t) : "");
      const bad = c.samples.find(has("Couldn't"));
      check("hang-once: no \"Couldn't\" text in any sample", !bad, bad ? `at ${fmt(bad.t)}: ${snippet(bad)}` : `${c.samples.length} samples`);
      const reqs = c.stub.forecastRequests();
      const outcomes = reqs.map((r) => r.outcome);
      const hungThenAnswered = [...Array(KINDS).fill("hang"), ...Array(KINDS).fill("200")].join(",");
      const answeredThenHung = [...Array(KINDS).fill("200"), ...Array(KINDS).fill("hang")];
      check(`hang-once: ${2 * KINDS} requests (${KINDS} hung, then ${KINDS} answered)`,
        outcomes.join(",") === hungThenAnswered || [...outcomes].sort().join(",") === [...answeredThenHung].join(","),
        reqs.map((r) => `${r.kind}:${r.outcome}@${fmt(r.t - c.t0)}`).join(" "));
      const hung = reqs.filter((r) => r.outcome === "hang");
      check("hang-once: the app aborted the hung requests after about 5 s",
        hung.every((r) => r.closedAt && r.closedAt - r.t >= 4_800 && r.closedAt - r.t <= 6_000),
        hung.map((r) => r.closedAt ? fmt(r.closedAt - r.t) : "still open").join(", "));
      console.log(`   list sample: ${snippet(loaded)}`);
    });
  },

  async hang(appPort) {
    await scenario("hang", "hang", appPort, async (c) => {
      const failed = await c.waitFor(has(TEXT.network), 20_000);
      check("hang: the network text shows", !!failed, failed ? "" : snippet(c.last()));
      const first = c.firstSample(has(TEXT.network));
      check("hang: it first shows after about 10 s (9.5 to 12.5 s: 5 s, one retry, 5 s)",
        !!first && first.t >= 9_500 && first.t <= 12_500, first ? fmt(first.t) : "");
      const early = c.samples.find((s) => s.t < 9_000 && s.text.includes("Couldn't"));
      check("hang: no failure shown before the retry finishes", !early, early ? snippet(early) : "");
      await sleep(8_000);
      const reqs = c.stub.forecastRequests();
      check(`hang: exactly ${2 * KINDS} requests (one retry, no second)`, reqs.length === 2 * KINDS,
        reqs.map((r) => `${r.kind}@${fmt(r.t - c.t0)}`).join(" "));
      const b = buttonMatching(/^Retry$/)(c.last());
      check("hang: Retry is enabled (no hold for a network failure)", !!b && !b.disabled, JSON.stringify(c.last().buttons));
      console.log(`   failed screen: ${snippet(first)}`);
    });
  },

  async hidden(appPort) {
    // A. Freeze and resume the page (what iOS does) during a hang-once load.
    await scenario("hidden A: Page.setWebLifecycleState frozen/active", "hang-once", appPort, async (c) => {
      await sleep(1_500);
      const before = await c.cdp.run("document.visibilityState");
      await c.cdp.run("window.__marker = performance.timeOrigin");
      let frozenResult = "ok";
      const tFrozen = c.elapsed();
      try { await c.cdp.send("Page.setWebLifecycleState", { state: "frozen" }); } catch (e) { frozenResult = e.message; }
      await sleep(8_000); // longer than the 5 s timeout
      const tActive = c.elapsed();
      let activeResult = "ok";
      try { await c.cdp.send("Page.setWebLifecycleState", { state: "active" }); } catch (e) { activeResult = e.message; }
      await sleep(500);
      const after = await c.cdp.run("document.visibilityState").catch((e) => `error: ${e.message}`);
      const vis = await c.cdp.run("JSON.stringify(window.__vis)").catch(() => "?");
      console.log(`   visibilityState before=${before} after=${after}; visibilitychange events: ${vis}; frozen: ${frozenResult}; active: ${activeResult}`);
      console.log(`   samples taken while frozen: ${c.samples.filter((s) => s.t > 1_500 && s.t < 9_500).length} (of ~16 expected)`);
      await sleep(6_000);
      console.log(`   visibilityState timeline (sampled): ${visTimeline(c.samples)}`);
      console.log(`   freeze/resume/pageshow/pagehide events: ${await c.cdp.run("JSON.stringify(window.__life)").catch(() => "?")}`);
      console.log(`   timing: frozen sent at ${fmt(tFrozen)}, active sent at ${fmt(tActive)}; hung requests closed at ${c.stub.forecastRequests().map((r) => r.closedAt ? fmt(r.closedAt - c.t0) : "-").join(",")}`);
      const same = await c.cdp.run("window.__marker === performance.timeOrigin").catch(() => "?");
      console.log(`   same document after active (window marker survived): ${same}`);
      console.log(`   in-page visibility poll (50 ms timer; ms since page start): ${await c.cdp.run("JSON.stringify(window.__poll)").catch(() => "?")}`);
      console.log(`   in-page fetch calls [ms, url tail, visibilityState]: ${await c.cdp.run("JSON.stringify(window.__fetches)").catch(() => "?")}`);
      console.log(`   final visibilitychange events: ${await c.cdp.run("JSON.stringify(window.__vis)").catch(() => "?")}`);
      const loaded = await c.waitFor(listLoaded, 20_000);
      console.log(`   INFO (not a check): the document was ${same === false ? "RELOADED by setWebLifecycleState frozen->active, not resumed" : "resumed"}; list loaded at ${loaded ? fmt(loaded.t) : "never"}`);
      console.log(`   requests (all, incl. osrm): ${c.stub.requests.map((r) => `${r.kind}:${r.outcome}@${fmt(r.t - c.t0)}`).join(" ")}`);
      console.log(`   requests: ${c.stub.forecastRequests().map((r) => `${r.kind}:${r.outcome}@${fmt(r.t - c.t0)}`).join(" ")}`);
      c.visibilityBecameHidden = String(vis).includes("hidden");
    });

    // B. A second tab brought to the front hides the first page for real. Then the first page is
    // brought back to the front. This is the real-Chrome version of the hidden-page path.
    await scenario("hidden B: second tab + Page.bringToFront (real hidden state)", "hang-once", appPort, async (c) => {
      await sleep(1_000);
      const second = await (await fetch(`http://127.0.0.1:${c.debugPort}/json/new?about:blank`, { method: "PUT" })).json();
      const other = await connect(second.webSocketDebuggerUrl);
      await other.send("Page.bringToFront");
      await sleep(500);
      const vs = await c.cdp.run("document.visibilityState");
      check("hidden B: opening a second tab + bringToFront makes the first page's document.visibilityState 'hidden'", vs === "hidden", `got ${vs}`);
      await sleep(8_000); // the 5 s timeout lands at ~5.6 s while hidden
      const reqsHidden = c.stub.forecastRequests().length;
      check(`hidden B: while hidden, no retry request is sent (still ${KINDS} hung requests)`, reqsHidden === KINDS, `${reqsHidden} requests`);
      check("hidden B: while hidden, no failure shown and no list (still loading)",
        !c.samples.some(has("Couldn't")) && c.last().text.includes("Loading forecast"), snippet(c.last()));
      await c.cdp.send("Page.bringToFront");
      const visibleAt = c.elapsed();
      await sleep(500);
      console.log(`   after Page.bringToFront on the first page: visibilityState=${await c.cdp.run("document.visibilityState")}; events ${await c.cdp.run("JSON.stringify(window.__vis)")}`);
      const loaded = await c.waitFor((s) => s.t > visibleAt && listLoaded(s), 10_000);
      check("hidden B: once visible again the retry runs and the list loads", !!loaded && c.stub.forecastRequests().length === 2 * KINDS,
        loaded ? `${fmt(loaded.t - visibleAt)} after bringToFront; ${c.stub.forecastRequests().length} requests` : snippet(c.last()));
      check("hidden B: no \"Couldn't\" text in any sample", !c.samples.some(has("Couldn't")));
      other.close();
    });

    // C. Simulated: override document.visibilityState (the property the app reads) and fire the
    // event. This exercises the app's wiring, not Chrome's real hidden state.
    await scenario("hidden C: simulated hidden page (visibilityState overridden)", "hang-once", appPort, async (c) => {
      await sleep(1_000);
      await c.cdp.run(`Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"))`);
      await sleep(8_500); // the 5 s timeout lands at ~5.6 s while "hidden"
      const mid = c.last();
      const reqsHidden = c.stub.forecastRequests().length;
      check(`hidden C: while hidden, no retry request is sent (still ${KINDS} hung requests)`, reqsHidden === KINDS, `${reqsHidden} requests`);
      check("hidden C: while hidden, no failure and no list is shown (still loading)",
        !c.samples.some(has("Couldn't")) && mid.text.includes("Loading forecast"), snippet(mid));
      const hungClosed = c.stub.forecastRequests().every((r) => r.closedAt);
      check("hidden C: the hung requests were aborted (timeout fired while hidden)", hungClosed);
      await c.cdp.run(`delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange"))`);
      const visibleAt = c.elapsed();
      const loaded = await c.waitFor((s) => s.t > visibleAt && listLoaded(s), 10_000);
      check("hidden C: after the page is visible again the retry runs and the list loads",
        !!loaded && c.stub.forecastRequests().length === 2 * KINDS, loaded ? `${fmt(loaded.t - visibleAt)} after visible; ${c.stub.forecastRequests().length} requests` : snippet(c.last()));
      check("hidden C: no \"Couldn't\" text in any sample", !c.samples.some(has("Couldn't")));
    });
  },
};

const visTimeline = (samples) => {
  const out = [];
  for (const s of samples) if (out.at(-1)?.[1] !== s.vis) out.push([fmt(s.t), s.vis]);
  return out.map(([t, v]) => `${t}:${v}`).join(" ");
};
const listLoaded = (s) => s.text.includes("Forecast from") && !s.text.includes("Couldn't");

// ---- main ----
const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(scenarios);
for (const n of names) if (!scenarios[n]) { console.error(`unknown scenario ${n}`); process.exit(2); }

const appPort = await freePort();
start(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], { cwd: root });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${appPort}/`)).ok) break; } catch {}
  await sleep(200);
}
console.log(`vite dev on ${appPort}`);
try {
  for (const n of names) await scenarios[n](appPort);
} finally {
  cleanup();
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
