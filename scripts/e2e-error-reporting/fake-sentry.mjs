// A stand-in for Sentry's ingest endpoint. Usage: node fake-sentry.mjs <events-file> <raw-file>
// Writes every request body to <raw-file> and each `event` item to <events-file>, one JSON per line.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [eventsFile, rawFile] = process.argv.slice(2);
writeFileSync(eventsFile, "");
writeFileSync(rawFile, "");

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    appendFileSync(rawFile, `${req.method} ${req.url}\n${body}\n`);
    // An envelope is newline-separated JSON: its header, then an item header and payload per item.
    const lines = body.split("\n").filter(Boolean);
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if (JSON.parse(lines[i]).type === "event") appendFileSync(eventsFile, `${lines[i + 1]}\n`);
    }
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end("{}");
  });
}).listen(9999, "127.0.0.1");
