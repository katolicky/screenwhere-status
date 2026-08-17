// @ts-check
// One tick of the public status page (w-a06b23): probe → fold into history → build the page.
//
//   node status/run.mjs                 probe, update history, write public/
//   node status/run.mjs --no-probe      rebuild public/ from the history already on disk
//   node status/run.mjs --dry           probe and print, write nothing
//
// Run by .github/workflows/status.yml every five minutes, from GitHub's fleet rather than from
// our own box — the whole point of route D (docs/STATUS-PAGE-PLAN.md § 5).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbes } from "./probe.mjs";
import { appendReading, buildStatus, emptyHistory } from "./history.mjs";
import { decide, emptyAlert, mentionFor, send, view } from "./alert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY = process.env.SW_STATUS_HISTORY || join(HERE, "history.json");
const INCIDENTS = process.env.SW_STATUS_INCIDENTS || join(HERE, "incidents.json");
const PUBLIC = process.env.SW_STATUS_PUBLIC || join(HERE, "public");

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };

const argv = process.argv.slice(2);
const noProbe = argv.includes("--no-probe");
const dry = argv.includes("--dry");

let hist = readJson(HISTORY, emptyHistory());
// A history file that predates a schema change, or a half-written one, must not take the run
// down — an empty store rebuilds itself in a day and a crashed cron reports nothing at all.
if (!hist || typeof hist !== "object" || !hist.days) hist = emptyHistory();

if (!noProbe) {
  const reading = await runProbes();
  const line = Object.entries(reading.states).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`${new Date(reading.ts).toISOString()}  ${line}`);
  for (const [k, v] of Object.entries(reading.detail)) if (reading.states[k] !== "ok") console.log(`    ${k}: ${v}`);
  if (dry) process.exit(0);
  hist = appendReading(hist, reading);

  // Alerting (w-bc5fa5). The decision is folded in BEFORE the history is written, and the
  // message is sent BEFORE `alert.state` flips on disk — so a webhook that does not go out
  // leaves the state untouched and the next tick tries again. The other order loses the
  // notification permanently and leaves a store insisting somebody was told.
  //
  // The state rides inside history.json because that file is the only thing that survives a
  // run: the workflow force-pushes it to the `status-data` branch and the runner is destroyed.
  const { alert, event } = decide(hist.alert || emptyAlert(), reading);
  let record = true;
  if (event) {
    const url = process.env.SW_STATUS_DISCORD_WEBHOOK || "";
    const v = view(event);
    console.log(`ALERT ${event.kind}: ${v.title} — ${event.ids.join(", ") || "—"}`);
    if (!url) {
      // Recorded anyway. Holding the transition until a webhook appears would deliver, weeks
      // later, the news that something was briefly down one Tuesday.
      console.log("::notice::An outage transition was detected and NOTHING was sent — no webhook configured. Setup: status/README.md § Alerting.");
    } else {
      const r = await send(url, v, mentionFor(event, process.env.SW_STATUS_DISCORD_MENTION));
      // ⚠️ A failed POST must not be remembered as "told them" — the next message anyone saw
      // would be the recovery, for an outage they were never notified of.
      if (!r.ok) { record = false; console.log(`::warning::Alert NOT delivered (${r.error}); state left unchanged so the next run retries.`); }
    }
  }
  if (record) hist.alert = alert;

  writeFileSync(HISTORY, JSON.stringify(hist));
}

const status = buildStatus(hist, readJson(INCIDENTS, []));
mkdirSync(PUBLIC, { recursive: true });
writeFileSync(join(PUBLIC, "status.json"), JSON.stringify(status, null, 2));
// index.html loads i18n.js as a module, so a publish that copies only the page ships a blank
// screen — the kind of break that looks like a CDN problem and is a missing line here.
for (const f of ["index.html", "i18n.js"]) {
  const src = join(HERE, f);
  if (existsSync(src)) copyFileSync(src, join(PUBLIC, f));
}
console.log(`overall=${status.overall} uptime90=${status.overallPct ?? "—"} → ${PUBLIC}`);

// `--serve` exists because the page CANNOT be opened over file:// — it loads i18n.js as a module
// and the browser refuses that from a file URL. Without this, "look at it" is an npx download.
// The port is high and overridable on purpose: the sibling worktree's devapp already owns 8791,
// and two tools quietly fighting over a port is a fault this repo has had (the loser keeps
// running and the browser shows the other one's page).
if (argv.includes("--serve")) {
  const { createServer } = await import("node:http");
  const { extname } = await import("node:path");
  const port = Number(process.env.SW_STATUS_PORT || 8845);
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
  createServer((q, s) => {
    const f = join(PUBLIC, (q.url === "/" ? "/index.html" : q.url || "/").split("?")[0]);
    // ⚠️ READ FIRST, THEN write the headers. The other order looks identical and takes the whole
    // server down: `readFileSync` throws with a 200 already on the wire, and the catch's 404 then
    // throws ERR_HTTP_HEADERS_SENT out of the request handler, which is an uncaught exception.
    // Chrome asks every origin for /favicon.ico unprompted, so the review tool died on its own
    // first page load, seconds in, and the tab just stopped refreshing.
    let body;
    try { body = readFileSync(f); } catch { s.writeHead(404); return s.end("not found"); }
    s.writeHead(200, { "content-type": `${TYPES[extname(f)] || "text/plain"}; charset=utf-8`, "cache-control": "no-store" });
    s.end(body);
  }).listen(port, () => console.log(`\n  http://127.0.0.1:${port}   (ctrl-c to stop)`));
}
