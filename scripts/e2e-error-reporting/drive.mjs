// Drives headless Chrome over the DevTools protocol. Usage: node drive.mjs
// Chrome must already be listening on port 9333 with app.test mapped to the preview server.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for Chrome to come up, then connect to its first page.
let page;
for (let i = 0; i < 100 && !page; i++) {
  try {
    const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
    page = targets.find((t) => t.type === "page");
  } catch {}
  if (!page) await sleep(200);
}
if (!page) throw new Error("Chrome did not start");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id !== undefined) pending.get(data.id)?.(data);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const run = async (expression) => {
  const { exceptionDetails, result } = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (exceptionDetails) throw new Error(`evaluating ${expression}: ${exceptionDetails.text}`);
  return result.value;
};

// Saved travel settings, so the app asks for drive times straight away. No reload after this:
// a reload would reset the once-per-load limits being checked.
const travel = {
  start: { kind: "place", name: "e2e", coordinate: { latitude: 40.015, longitude: -105.27 } },
  maxHours: 4,
};
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `localStorage.setItem("willItFly.travel.v1", ${JSON.stringify(JSON.stringify(travel))})`,
});
// The query string is something the reports must never contain.
await send("Page.navigate", { url: "http://app.test:4173/?e2e=pagequery" });
await sleep(10_000);

// The visibility tag only means something if the page was visible while it ran.
const visibility = await run("document.visibilityState");
if (visibility !== "visible") throw new Error(`page is ${visibility}, not visible`);

// Uncaught errors and unhandled rejections, then a burst to hit the per-load cap.
await run(`setTimeout(() => { throw new Error("e2e-uncaught") })`);
await run(`Promise.reject(new Error("e2e-rejection"))`);
await sleep(2_000);
await run(`for (let i = 0; i < 30; i++) setTimeout(() => { throw new Error("e2e-burst-" + i) })`);
await sleep(5_000);
ws.close();
