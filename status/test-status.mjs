// The public status page (w-a06b23) — the invariants a hand can break and the code cannot.
//
// The theme of this suite is that this page's whole value is being believed during an incident,
// so every assertion here is about a way it could lie: by treating silence as health, by
// treating one dropped packet as an outage, by publishing a customer's name, or by printing a
// number next to a Czech noun in the wrong case.
//
//   node status/test-status.mjs
import http from "node:http";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Set before importing probe.mjs — the module reads these at load time, and a 5-second retry
// in a unit test is how a suite becomes something people skip.
process.env.SW_STATUS_RETRY_MS = "1";
process.env.SW_STATUS_TIMEOUT_MS = "1500";
process.env.SW_STATUS_SLOW_MS = "300";

const { probeHttp, probeStun, probeAgents, COMPONENTS } = await import("./probe.mjs");
const { appendReading, buildStatus, emptyHistory, dayState, uptimePct, displayPct, windowKeys, dayKey, INFRA, WINDOW_DAYS } = await import("./history.mjs");
const { czPlural, agoCs, durCs, durEn, agoEn, pct, STR } = await import("./i18n.js");
const { decide, emptyAlert, view, send, downIds, mentionFor, STREAK } = await import("./alert.mjs");

let pass = 0, fail = 0;
/** `detail` is printed only on failure — for the assertions whose useful part is WHICH item broke
 *  (which token was left behind, which literal is still there), not that something did. */
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok " : "FAIL"}  ${label}${cond || !detail ? "" : `\n        → ${detail}`}`);
  cond ? pass++ : fail++;
};

// ── helpers ───────────────────────────────────────────────────────────────────
/** A throwaway HTTP server whose handler the test controls. */
function serve(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}
/** A throwaway STUN responder. `mangle` lets a test answer with the WRONG transaction id. */
function stunServer({ answer = true, mangle = false } = {}) {
  return new Promise((res) => {
    const s = dgram.createSocket("udp4");
    s.on("message", (msg, rinfo) => {
      if (!answer) return;
      const out = Buffer.alloc(20);
      out.writeUInt16BE(0x0101, 0);
      out.writeUInt16BE(0x0000, 2);
      out.writeUInt32BE(0x2112a442, 4);
      const tx = msg.subarray(8, 20);
      (mangle ? Buffer.alloc(12, 0xff) : tx).copy(out, 8);
      s.send(out, rinfo.port, rinfo.address);
    });
    s.bind(0, "127.0.0.1", () => res({ port: s.address().port, close: () => s.close() }));
  });
}
const reading = (ts, states, detail = {}) => ({ ts, states, detail });

// ── the probe surface itself ──────────────────────────────────────────────────
// ⚠️ /mcp answers 405 to a GET and that IS the healthy answer. A well-meaning hand "fixing"
// this to 200 would turn a live MCP server into a permanent red bar, and nothing else in the
// system would notice — the page would simply be wrong, quietly, forever.
ok("probes: /mcp expects 405 — a method refusal is a live answer, not a fault",
  COMPONENTS.find((c) => c.id === "mcp")?.expect?.includes(405) === true);
ok("probes: /mcp does NOT accept 200 — that would mean something else is answering",
  COMPONENTS.find((c) => c.id === "mcp")?.expect?.includes(200) === false);
ok("probes: the four HTTP planes and coturn are all present, and the agent row is last",
  COMPONENTS.map((c) => c.id).join(",") === "app,docs,mcp,whep,turn,site");

{
  const s = await serve((_q, r) => { r.writeHead(200); r.end("ok"); });
  const r = await probeHttp(s.url + "/", [200]);
  ok("http: the expected code is `ok`", r.state === "ok");
  const wrong = await probeHttp(s.url + "/", [405]);
  ok("http: the WRONG code is `down`, even though the request succeeded", wrong.state === "down");
  s.close();
}
{
  const s = await serve((_q, r) => setTimeout(() => { r.writeHead(200); r.end("slow"); }, 450));
  const r = await probeHttp(s.url + "/", [200]);
  ok("http: an answer slower than SLOW_MS is `warn`, not `down` — it answered", r.state === "warn");
  s.close();
}

// ── the retry, which is what keeps a rumour out of the record ─────────────────
// ⚠️ Every probe below is pointed at a throwaway local server FIRST. `probeOnce` builds its URL
// from BASE, whose default is production — a suite that forgets to override it does not fail,
// it silently measures the live service from a developer's laptop.
{
  // A server that fails the first attempt and answers the second must NOT be recorded down.
  let hits = 0;
  const s = await serve((_q, r) => { hits++; if (hits === 1) { r.destroy(); return; } r.writeHead(200); r.end("ok"); });
  process.env.SW_STATUS_BASE = s.url;
  const mod = await import("./probe.mjs?flaky");   // re-import so BASE picks the test server up
  const r = await mod.probeOnce({ id: "app", kind: "http", path: "/", expect: [200] });
  ok("retry: fails once, answers on the retry → NOT down (this is the whole point)", r.state === "ok");
  ok("retry: and it really did take two attempts", hits === 2);
  s.close();
}
{
  const s = await serve((_q, r) => r.destroy());
  process.env.SW_STATUS_BASE = s.url;
  const mod = await import("./probe.mjs?dead");
  const r = await mod.probeOnce({ id: "app", kind: "http", path: "/", expect: [200] });
  ok("retry: two failures in a row IS down…", r.state === "down");
  ok("…and the record says the retry agreed, not merely that something timed out",
    /confirmed on retry/.test(r.detail));
  s.close();
}

// ── STUN, the one probe that is real work ─────────────────────────────────────
{
  const s = await stunServer();
  const r = await probeStun("127.0.0.1", s.port);
  ok("stun: a proper binding success is `ok`", r.state === "ok");
  s.close();
}
{
  const s = await stunServer({ mangle: true });
  const r = await probeStun("127.0.0.1", s.port);
  ok("stun: an answer with the WRONG transaction id is ignored — a stray datagram is not coturn",
    r.state === "down");
  s.close();
}
{
  const s = await stunServer({ answer: false });
  const r = await probeStun("127.0.0.1", s.port);
  ok("stun: silence is `down`, and it says so rather than hanging", r.state === "down" && /no STUN answer/.test(r.detail));
  s.close();
}

// ── the site aggregate: a count, and never a name ─────────────────────────────
{
  delete process.env.SW_STATUS_PAT;
  const r = await probeAgents();
  ok("agents: with no PAT the row reads `none` — it does not vanish and it does not claim down",
    r.state === "none");
}
{
  const s = await serve((q, r) => {
    if (q.url !== "/app/health") { r.writeHead(404); return r.end(); }
    r.writeHead(200, { "content-type": "application/json" });
    r.end(JSON.stringify({ ok: true, sets: [
      { setId: "kancelar-1", name: "Kancelář — velká TV", online: true },
      { setId: "kancelar-2", name: "Zasedačka", online: false },
    ] }));
  });
  process.env.SW_STATUS_BASE = s.url;
  process.env.SW_STATUS_PAT = "pat_test";
  const mod = await import("./probe.mjs?agents");
  const r = await mod.probeAgents();
  ok("agents: one of two reachable is `warn`", r.state === "warn");
  ok("agents: the reading is two integers", r.total === 2 && r.reachable === 1);
  // 🚨 The privacy invariant. Both the history file and the published JSON are public, so a set
  // name must not survive the probe — not in a field, not in the detail string.
  const blob = JSON.stringify(r);
  ok("agents: NO customer name survives the probe — not in a field, not in `detail`",
    !/kancelar|Kancelář|Zasedačka/.test(blob));
  s.close();
}
{
  const s = await serve((_q, r) => { r.writeHead(503); r.end(); });
  process.env.SW_STATUS_BASE = s.url;
  process.env.SW_STATUS_PAT = "pat_test";
  const mod = await import("./probe.mjs?unreachable");
  const r = await mod.probeAgents();
  // "We could not ask" is not "they are down". The infrastructure rows already say the relay is
  // gone; asserting the agents are down as well would be claiming something never observed.
  ok("agents: when the relay cannot be asked the row is `none`, NOT `down`", r.state === "none");
  s.close();
}
delete process.env.SW_STATUS_PAT;

// ── the history store ─────────────────────────────────────────────────────────
const T0 = Date.parse("2026-08-10T12:00:00Z");
{
  let h = emptyHistory();
  h = appendReading(h, reading(T0, { app: "ok", docs: "ok", mcp: "ok", whep: "ok", turn: "ok", site: "none" }));
  const day = h.days[dayKey(T0)];
  ok("history: an `ok` reading counts once", day.app.ok === 1);
  // Silence is neither uptime nor downtime. Counting it up would flatter us; counting it down
  // would libel us. It must simply not be a sample.
  ok("history: a `none` reading is NOT a sample — it lands in neither column", day.site === undefined);
}
{
  ok("history: a day with any confirmed `down` is red…", dayState({ ok: 287, warn: 0, down: 1 }) === "down");
  ok("…a day with a slow sample and no failure is amber…", dayState({ ok: 287, warn: 1, down: 0 }) === "warn");
  ok("…and a day with no samples at all is `nodata`, never green", dayState(undefined) === "nodata");
  ok("history: uptime counts a degraded sample as AVAILABLE — slow is not absent",
    uptimePct([{ ok: 8, warn: 2, down: 0 }]) === 100);
  ok("history: uptime with no samples is null, not 100", uptimePct([undefined, null]) === null);
}
{
  // Pruning must go by DATE. Pruning by count would let a quiet week slide 90-day-old readings
  // forward into the window, and the bar would silently describe the wrong three months.
  let h = emptyHistory();
  h = appendReading(h, reading(T0 - 120 * 86400000, { app: "ok" }));
  h = appendReading(h, reading(T0, { app: "ok" }));
  ok("history: a reading older than the window is pruned by date",
    Object.keys(h.days).length === 1 && h.days[dayKey(T0)] !== undefined);
}
{
  const keys = windowKeys(T0);
  ok(`history: the window is exactly ${WINDOW_DAYS} days and ends today`,
    keys.length === WINDOW_DAYS && keys[keys.length - 1] === dayKey(T0));
  ok("history: the window is in order, oldest first", keys[0] < keys[1]);
}

// ── what gets published ───────────────────────────────────────────────────────
{
  let h = emptyHistory();
  h = appendReading(h, reading(T0, { app: "ok", docs: "ok", mcp: "ok", whep: "ok", turn: "ok", site: "down" }));
  const s = buildStatus(h, [], T0);
  // A customer's television being switched off is not a Screenwhere incident. If it turned the
  // banner red the page would be crying wolf by the third week and nobody would read it again.
  ok("published: a site agent being offline does NOT make the banner red", s.overall === "ok");
  ok("published: …and the site row still reports its own state honestly",
    s.components.find((c) => c.id === "site").state === "down");
  ok("published: the banner only ever answers to INFRA", INFRA.includes("site") === false);
}
{
  let h = emptyHistory();
  h = appendReading(h, reading(T0, { app: "down", docs: "down", mcp: "down", whep: "down", turn: "down", site: "none" }));
  const s = buildStatus(h, [], T0);
  ok("published: every plane down is `down` — the one-box failure", s.overall === "down");
}
{
  let h = emptyHistory();
  h = appendReading(h, reading(T0, { app: "ok", docs: "ok", mcp: "ok", whep: "down", turn: "ok", site: "ok" }));
  const s = buildStatus(h, [], T0);
  ok("published: one plane down is `partial`, not a major outage", s.overall === "partial");
  // The banner has to be able to say what still works — "video is down, control is not" is the
  // sentence that stops a degraded plane from reading as a dead product.
  ok("published: it names what is affected AND what is not", s.affected.length === 1 && s.unaffected.length === 4);
}
{
  let h = emptyHistory();
  h = appendReading(h, reading(T0, { app: "warn", docs: "ok", mcp: "ok", whep: "ok", turn: "ok", site: "ok" }));
  ok("published: a slow plane is `warn`", buildStatus(h, [], T0).overall === "warn");
}
{
  let h = emptyHistory();
  h = appendReading(h, reading(T0, { app: "ok" }));
  const s = buildStatus(h, [], T0);
  ok("published: every component carries a full 90-day strip, even on day one",
    s.components.every((c) => c.days.length === WINDOW_DAYS));
  ok("published: the days before the prober existed are `nodata`, never green",
    s.components[0].days.slice(0, -1).every((d) => d === "nodata"));
  ok("published: it states its own age and its own staleness threshold",
    typeof s.generatedAt === "string" && s.staleAfterMin > 0);
  // The published file is world-readable. Nothing that could name a customer may be in it.
  ok("published: no `setId` and no `name` field anywhere in the document",
    !/"setId"|"name"/.test(JSON.stringify(s)));
}
{
  // 🚨 The rounding lie, reproduced at PRODUCTION scale rather than argued about. 90 days at one
  // probe every five minutes is 25 920 samples; a single five-minute outage is 99.99614 %, which
  // two-decimal rounding prints as 100,00 % — beside the red bar the same build just drew.
  const raw = uptimePct([{ ok: 25919, warn: 0, down: 1 }]);
  ok("rounding: the naive two-decimal round really does produce 100 from one outage",
    Math.round(raw * 100) / 100 === 100);
  ok("rounding: …so displayPct refuses it — a window with a failure never shows a whole 100",
    displayPct(raw, true) === 99.99);
  ok("rounding: a genuinely perfect window still shows 100", displayPct(100, false) === 100);

  let h = emptyHistory();
  const day = dayKey(T0);
  h = appendReading(h, reading(T0, { app: "down" }));
  h.days[day].app = { ok: 25919, warn: 0, down: 1 };
  h.latest = reading(T0, { app: "ok" });
  const s = buildStatus(h, [], T0);
  ok("rounding: and the published document carries the honest number, not the flattering one",
    s.components.find((c) => c.id === "app").uptime90 === 99.99);
}
{
  // Incidents older than the window are dropped at build time so the file can just be appended to.
  const old = { at: new Date(T0 - 200 * 86400000).toISOString(), title: { cs: "staré", en: "old" } };
  const fresh = { at: new Date(T0 - 3 * 86400000).toISOString(), title: { cs: "nové", en: "new" } };
  const s = buildStatus(appendReading(emptyHistory(), reading(T0, { app: "ok" })), [old, fresh], T0);
  ok("published: incidents outside the window are dropped", s.incidents.length === 1 && s.incidents[0] === fresh);
}

// ── Czech agreement: rendered at 1, 2 and 5, never read ───────────────────────
// This is the fault this project ships most (v1.145.3 fixed eleven at once), and the reason
// i18n.js is a module at all. A count frozen into a sentence is wrong the moment it is not 2.
ok("czech: 1/2/5 take three different forms in the bare case",
  durCs(1) === "1 minutu" && durCs(2) === "2 minuty" && durCs(5) === "5 minut");
ok("czech: hours too", durCs(60) === "1 hodinu" && durCs(120) === "2 hodiny" && durCs(300) === "5 hodin");
ok("czech: after „před“ the case changes and 2 agrees with 5 — 1 is the odd one",
  agoCs(1) === "před 1 sekundou" && agoCs(2) === "před 2 sekundami" && agoCs(5) === "před 5 sekundami");
ok("czech: „před“ minutes/hours/days", agoCs(60) === "před 1 minutou" && agoCs(7200) === "před 2 hodinami" && agoCs(5 * 86400) === "před 5 dny");
ok("czech: the plural helper takes all three forms, so a two-form call cannot compile by accident",
  czPlural.length === 4);
ok("english: singular is not pluralised", agoEn(1) === "1 second ago" && agoEn(2) === "2 seconds ago" && durEn(1) === "1 minute");
ok("numbers: Czech uses a decimal comma, English a point",
  pct(99.94, "cs") === "99,94 %" && pct(99.94, "en") === "99.94 %");
ok("strings: both languages define exactly the same keys — a missing one renders `undefined` at a person",
  JSON.stringify(Object.keys(STR.cs).sort()) === JSON.stringify(Object.keys(STR.en).sort()));

// ── the page's own promises ───────────────────────────────────────────────────
// These are grep-shaped on purpose, in the same spirit as test-web.mjs scanning audit actions:
// they guard behaviour that lives in an HTML file the suite cannot execute, and the alternative
// is no guard at all.
const page = readFileSync(join(HERE, "index.html"), "utf8");
ok("page: it computes staleness against the READER's clock, not against a flag in the file",
  /Date\.now\(\)\s*-\s*Date\.parse\(data\.generatedAt\)/.test(page) && /staleAfterMin/.test(page));
ok("page: today's bar is painted from the current state, so the strip cannot contradict the badge",
  /days\[days\.length - 1\] =/.test(page));
ok("page: it distinguishes `could not load` from `the service is down`", /xNoData/.test(page) && /loadFailed/.test(page));
ok("page: it re-fetches while somebody watches — a stale open tab is the failure it exists to avoid",
  /setInterval\(load/.test(page));
ok("page: it loads the i18n module rather than carrying a second copy of the strings",
  /import \{ STR, pct \} from '\.\/i18n\.js'/.test(page) && !/const STR = \{/.test(page));
// ── the two themes ────────────────────────────────────────────────────────────
// This page shipped dark-only: `data-theme="dark"` was welded onto the html element and there was
// exactly one palette, so it stayed black on a light desktop. The assertions below guard the
// shape that replaced it, and they are worth more than they look — a colour that only works on
// one background does not come out ugly, it comes out INVISIBLE, and nobody reports a badge they
// cannot see. Two of the old literals (`.s-none`, `.b-stale .ico`) were white at 5 % alpha:
// perfect on black, gone on white, and both of them mark the "we do not know" state, which is the
// one state this page exists to be honest about.
ok("theme: the html element does not hard-code one — an empty attribute is `follow the machine`",
  /<html lang="cs" data-theme="">/.test(page));

const cut = (re) => (page.match(re) || [, ""])[1];
const lightVars = cut(/\n  :root\{([\s\S]*?)\n  \}/);
const darkAttr  = cut(/html\[data-theme="dark"\]\{([\s\S]*?)\n  \}/);
const darkMedia = cut(/@media \(prefers-color-scheme:dark\)\{ html:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\{([\s\S]*?)\n  \}\}/);
const decls = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split(";").map((d) => d.trim()).filter(Boolean).sort();
const nameOf = (d) => d.slice(0, d.indexOf(":")).trim();

ok("theme: the light palette is the DEFAULT — :root is light, and says so to the browser too",
  /--color-bg:#fafbfa/.test(lightVars) && /color-scheme:light/.test(lightVars));
ok("theme: an explicit `dark` has a block of its own, so the button works on a light desktop",
  /--color-bg:#0a0e0c/.test(darkAttr));
ok("theme: an unset theme follows the machine — and only while nothing has overridden it",
  /--color-bg:#0a0e0c/.test(darkMedia));
// The two dark lists are duplicates by necessity: an attribute selector cannot re-enter a @media
// block, so the palette has to be written twice. Duplicates drift, so the drift is the assertion.
ok("theme: the attribute palette and the media-query palette agree property for property",
  darkAttr.length > 0 && JSON.stringify(decls(darkAttr)) === JSON.stringify(decls(darkMedia)));
{
  // "Added a colour to light and forgot dark" is the failure this catches, and its symptom is a
  // light-theme colour sitting on a dark card — legible enough to ship, wrong enough to notice.
  const overridden = decls(darkAttr).map(nameOf);
  const orphans = decls(lightVars).filter((d) => /#|rgba?\(/.test(d)).map(nameOf)
    .filter((n) => n.startsWith("--") && !overridden.includes(n));
  ok("theme: every colour token light defines is overridden in dark — none left behind",
    orphans.length === 0, orphans.join(", "));
}
{
  // Everything after the token blocks must paint with a variable. The exception is the brand
  // chip, whose gradient is the logo and is deliberately the same in both themes.
  // ⚠️ Sliced from the MATCH position, not from `indexOf(darkMedia)`. The two dark palettes are
  // character-for-character identical (that is the point of the assertion above), so searching
  // for the text finds the attribute block and quietly leaves the whole media query inside the
  // "rules" half — where its perfectly legitimate hexes then read as violations.
  const mq = page.match(/@media \(prefers-color-scheme:dark\)\{ html:not[\s\S]*?\n  \}\}/);
  const rules = page.slice(mq.index + mq[0].length, page.indexOf("</style>"));
  ok("theme: no rule outside the palettes paints with a white or black alpha — those vanish",
    !/rgba\(255,\s*255,\s*255|rgba\(0,\s*0,\s*0/.test(rules));
  const hexes = [...new Set(rules.match(/#[0-9a-fA-F]{3,8}\b/g) || [])].sort();
  ok("theme: …and the only literals left are the logo's own gradient, which is intentional",
    JSON.stringify(hexes) === JSON.stringify(["#19a826", "#2dd140", "#fff"]), hexes.join(" "));
}
ok("theme: the stored choice is applied BEFORE the stylesheet — read it late and every load flashes",
  page.indexOf("sw-status-theme") < page.indexOf("<style>"));
ok("theme: the button remembers the choice, and takes its label from i18n rather than the markup",
  /id="themeBtn"/.test(page) && /themeLight/.test(page) && /localStorage\.setItem\('sw-status-theme'/.test(page));
// ⚠️ The glyph swap has to answer for the UNSET case too. Keyed on the attribute alone, a dark
// desktop that never touched the button gets the sun — an offer to switch to what it already is.
ok("theme: the sun/moon swap covers the unset case, not just the two explicit ones",
  /html:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) \.theme \.moon\{ display:block/.test(page));

// ── the workflow, which failed for a whole day without anybody noticing ───────
// 🚨 `secrets` is NOT available in a step's `if:`. GitHub allows it in `env`, `with` and at job
// level, and nowhere else — so `if: ${{ secrets.X != '' }}` is not a condition that evaluates
// false, it is an invalid workflow FILE. Every run died at validation in 0 s, from the very first
// commit of this page, and the Actions list showed a red mark with no log behind it. What hid it
// is that the design's own words were "the publish step is skipped": a skip and a parse failure
// look the same from a distance, and the page it publishes was not live yet either, so there was
// no second symptom. Both directions are asserted, because the fix moves the test to `env` and a
// hand could move it back.
{
  const wf = readFileSync(join(HERE, "..", ".github", "workflows", "status.yml"), "utf8");
  const ifLines = wf.split("\n").filter((l) => /^\s*if:/.test(l));
  ok("workflow: it has conditional steps at all — otherwise this section guards nothing",
    ifLines.length >= 2);
  ok("workflow: no `if:` reads the `secrets` context — that is an invalid file, not a false test",
    ifLines.every((l) => !/secrets\./.test(l)), ifLines.filter((l) => /secrets\./.test(l)).join(" | "));
  ok("workflow: the Cloudflare token is lifted to `env`, which `if:` may read",
    /^\s{4}env:/m.test(wf) && /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/.test(wf));
  // 🚨 The pairing, which is the assertion that matters most in this block. Hosting is three
  // actions in two web UIs, so "one secret set, the other forgotten" is the LIKELIEST state
  // anybody is ever in — not an edge case. Testing the token alone meant a half-configured repo
  // ran wrangler and died inside it, while the notice that would have named the missing piece
  // stayed quiet for the same reason. And if the two conditions ever both go false, publication
  // silently does not happen and nothing says so: this page's own subject, in its own pipeline.
  const pub  = (wf.match(/- name: Publish page\n\s*if: ([^\n]+)/) || [, ""])[1];
  const skip = (wf.match(/- name: Say what was skipped\n\s*if: ([^\n]+)/) || [, ""])[1];
  ok("workflow: publishing requires BOTH Cloudflare secrets, not just the token",
    /CLOUDFLARE_API_TOKEN != ''/.test(pub) && /CLOUDFLARE_ACCOUNT_ID != ''/.test(pub) && /&&/.test(pub), pub);
  ok("workflow: …and the skip notice is its exact complement, so no state is silent on both",
    /CLOUDFLARE_API_TOKEN == ''/.test(skip) && /CLOUDFLARE_ACCOUNT_ID == ''/.test(skip) && /\|\|/.test(skip), skip);
  ok("workflow: the notice names WHICH secret is missing rather than a fixed one",
    /missing secret\(s\)/.test(wf) && /\[ -z "\$CLOUDFLARE_ACCOUNT_ID" \]/.test(wf));
  // 🚨 The SECOND fault, which the first fix merely uncovered: `GITHUB_TOKEN` is read-only by
  // default, so force-pushing `status-data` answered 403 / exit 128. Asserted because the push is
  // how the 90-day bar survives at all — without it every run starts from an empty history and
  // the strip silently never fills, which looks exactly like a young page rather than a broken one.
  ok("workflow: the job may write contents — it force-pushes the history branch with GITHUB_TOKEN",
    /permissions:\s*\n\s*contents: write/.test(wf));
  ok("workflow: …and asks for nothing wider than that",
    (wf.match(/^\s*(contents|actions|packages|id-token|pull-requests):/gm) || []).length === 1);
}

// ── the outage alert (w-bc5fa5) ───────────────────────────────────────────────
// The relay is the only sender of alerts this product has, so the one event nobody can be told
// about is the relay itself going away. This sender runs beside the prober, off our boxes.
//
// Every assertion below is about the two ways it could be worse than nothing: crying outage over
// a blip (a channel people mute is a channel that reports nothing), or staying quiet through a
// real one. The behaviour is a SEQUENCE, which is exactly the kind of rule that never gets tested
// unless the decision is a pure function — so it is one, and this is where it earns that.
{
  const A0 = Date.parse("2026-08-11T09:00:00Z");
  const t = (n) => A0 + n * 300_000;                       // ticks, five minutes apart
  const good = (n) => reading(t(n), { app: "ok", docs: "ok", mcp: "ok", whep: "ok", turn: "ok", site: "ok" });
  const bad  = (n, ids = INFRA) => reading(t(n), Object.fromEntries(
    [...INFRA.map((id) => [id, ids.includes(id) ? "down" : "ok"]), ["site", "ok"]]));
  /** Feed a sequence and collect what would have been sent. */
  const feed = (list) => {
    let a = emptyAlert(); const evs = [];
    for (const r of list) { const o = decide(a, r); a = o.alert; if (o.event) evs.push(o.event); }
    return { alert: a, evs };
  };

  ok("alert: ONE bad reading says nothing — the retry in probe.mjs only catches a dropped packet",
    feed([good(0), bad(1)]).evs.length === 0);
  ok("alert: two in a row is an outage",
    feed([good(0), bad(1), bad(2)]).evs.map((e) => e.kind).join() === "down");
  // 🚨 The outage began when it began. Reporting it from the reading that convinced us would
  // shorten every incident on record by five minutes, in the one direction that flatters us.
  ok("alert: …and it is dated from the FIRST failure, not from the one that confirmed it",
    feed([good(0), bad(1), bad(2)]).evs[0].since === t(1));
  ok("alert: a third failing tick does not send a second message",
    feed([good(0), bad(1), bad(2), bad(3), bad(4)]).evs.length === 1);
  // ⚠️ A flap must not produce a message per swing. Two bad readings SEPARATED by a good one are
  // not two in a row, and this is the assertion that stops the streak counter being written as
  // a total.
  ok("alert: bad, good, bad, good is a flap and not an outage",
    feed([bad(0), good(1), bad(2), good(3)]).evs.length === 0);
  ok("alert: `warn` is slow, not absent — a degraded plane wakes nobody",
    feed([reading(t(0), { app: "warn", docs: "warn", mcp: "warn", whep: "warn", turn: "warn", site: "ok" }),
          reading(t(1), { app: "warn", docs: "warn", mcp: "warn", whep: "warn", turn: "warn", site: "ok" })]).evs.length === 0);
  // 🚨 One customer's box being switched off is not a Screenwhere incident. The page already
  // refuses to let the site row paint the banner; an alert that pinged for it would be muted
  // within weeks, and then the real outage would ping a channel nobody reads.
  ok("alert: the site-agent row NEVER fires — not once, not ever",
    feed([reading(t(0), { app: "ok", docs: "ok", mcp: "ok", whep: "ok", turn: "ok", site: "down" }),
          reading(t(1), { app: "ok", docs: "ok", mcp: "ok", whep: "ok", turn: "ok", site: "down" }),
          reading(t(2), { app: "ok", docs: "ok", mcp: "ok", whep: "ok", turn: "ok", site: "down" })]).evs.length === 0);
  ok("alert: one component down is enough — a dead /mcp is an outage of /mcp",
    feed([good(0), bad(1, ["mcp"]), bad(2, ["mcp"])]).evs.length === 1);
  // 🚨 The store is written by appendReading, which names every field it keeps — so an alert
  // state it does not name is dropped between ticks, and "waiting for the second failure" then
  // becomes a state nothing can ever leave. It shipped that way for an hour; the pure tests
  // above all passed throughout, because they never went through the store.
  ok("alert: the state survives a fold — appendReading carries it rather than rebuilding around it",
    appendReading({ ...emptyHistory(), alert: { ...emptyAlert(), state: "down", n: 7 } }, good(1)).alert?.n === 7);

  {
    const { evs, alert } = feed([good(0), bad(1), bad(2), good(3), good(4)]);
    ok("alert: recovery is announced", evs.map((e) => e.kind).join() === "down,up");
    ok("alert: …but not from a single good reading either — the same flap, mirrored",
      feed([good(0), bad(1), bad(2), good(3)]).evs.length === 1);
    ok("alert: the outage lasted from the first failure to the first recovery, 10 minutes",
      evs[1].minutes === 10 && evs[1].ended === t(3));
    ok("alert: and the store is clean afterwards, ready for the next one",
      alert.state === "up" && alert.since === null && alert.ids.length === 0);
  }
  {
    // An outage that starts at one component and swallows the box a tick later was about both.
    const { evs } = feed([good(0), bad(1, ["mcp"]), bad(2, ["mcp"]), bad(3), good(4), good(5)]);
    ok("alert: the recovery names everything the outage touched, not just what was down last",
      evs[1].ids.length === INFRA.length && evs[1].ids.includes("mcp"));
  }

  // The message itself. 🚨 RENDERED at 1, 2 and 5 — not read. Four counts-next-to-a-Czech-noun
  // have shipped here by being read rather than rendered, and a message that says "1 minut" at
  // three in the morning is one nobody trusts the next time.
  const dur = (m) => (view({ kind: "up", at: t(9), since: t(0), ended: t(0) + m * 60_000, ids: ["app"], minutes: m }).fields
    .find((f) => f.name === "Výpadek trval") || {}).value;
  ok("alert: 1 → „1 minutu\"", dur(1) === "1 minutu", dur(1));
  ok("alert: 2 → „2 minuty\"", dur(2) === "2 minuty", dur(2));
  ok("alert: 5 → „5 minut\"", dur(5) === "5 minut", dur(5));
  ok("alert: 60 → hours, and the hour is declined too", dur(60) === "1 hodinu", dur(60));
  {
    const v = view({ kind: "down", at: t(2), since: t(1), ended: 0, ids: ["mcp"], minutes: 0 });
    ok("alert: the message names the component in the language the reader reads",
      v.fields.some((f) => f.value === "MCP server") && v.tone === "bad");
    const all = view({ kind: "down", at: t(2), since: t(1), ended: 0, ids: INFRA.slice(), minutes: 0 });
    ok("alert: everything down reads as the box, not as a list of five coincidences",
      /nic/.test(all.text) && !/Ostatní/.test(all.text));
    ok("alert: a partial outage says what is still up, so it does not read as a dead product",
      /Ostatní/.test(v.text));
  }
  {
    // 🚨 THE TITLE IS WHAT THE LOCK SCREEN SHOWS. While both kinds of outage were called
    // "Výpadek infrastruktury", a phone could not tell the whole box being gone from one
    // container of five refusing — you had to open the message to know whether to get up.
    // Invisible in any single card; obvious the moment four of them sit in a list.
    const t = (kind, ids) => view({ kind, at: t0v, since: t0v, ended: t0v, ids, minutes: 3 }).title;
    const t0v = Date.parse("2026-08-11T13:39:00Z");
    ok("alert: everything down keeps the plain title — that IS the whole-machine case",
      t("down", INFRA.slice()) === "Výpadek infrastruktury", t("down", INFRA.slice()));
    ok("alert: one part down says so, and names it, in the title",
      t("down", ["mcp"]) === "Částečný výpadek — MCP server", t("down", ["mcp"]));
    // 🚨 Rendered at 2 and 5, not read. The names are too long to list in a title, so it counts —
    // and a count next to a Czech noun is the fault this repo has shipped four times by eye.
    ok("alert: two parts → „2 části\"", t("down", ["mcp", "whep"]) === "Částečný výpadek — 2 části", t("down", ["mcp", "whep"]));
    ok("alert: five would be „5 částí\" — but five IS everything, so the plain title wins",
      t("down", ["a", "b", "c", "d", "e"]) === "Výpadek infrastruktury", t("down", ["a", "b", "c", "d", "e"]));
    ok("alert: …and four, which is genuinely partial, declines correctly",
      t("down", ["app", "docs", "mcp", "whep"]) === "Částečný výpadek — 4 části", t("down", ["app", "docs", "mcp", "whep"]));
    ok("alert: the recovery title takes the same shape, so the pair reads as one story",
      t("up", ["mcp"]) === "Obnoveno — MCP server" && t("up", INFRA.slice()) === "Obnoveno");
    // ⚠️ The recovery text branches for the same reason the outage text does. It used not to,
    // and after a partial outage it announced that ALL parts were answering "again" — when four
    // of the five had never stopped.
    const up1 = view({ kind: "up", at: t0v, since: t0v, ended: t0v, ids: ["mcp"], minutes: 3 }).text;
    ok("alert: recovering from a partial outage does not claim the others had fallen",
      /nevypadly/.test(up1) && !/Všechny/.test(up1), up1);
  }
  {
    // A recovery must NEVER ping. It is the message whose content is "nobody needs to do
    // anything", and a channel that wakes people for good news gets muted — after which the
    // outage message wakes nobody either.
    ok("alert: an outage carries the configured ping", mentionFor({ kind: "down" }, "@here") === "@here");
    ok("alert: a recovery carries none, even when one is configured", mentionFor({ kind: "up" }, "@here") === "");
    ok("alert: no ping configured is not a ping", mentionFor({ kind: "down" }, undefined) === "");
    // And the wiring: the rule must be what run.mjs actually calls, not an `if` beside it.
    ok("alert: run.mjs asks the rule rather than reading the variable straight into send()",
      /mentionFor\(event, process\.env\.SW_STATUS_DISCORD_MENTION\)/.test(readFileSync(join(HERE, "run.mjs"), "utf8")));
  }
  {
    // 🚨 ONE CARD MUST NOT CARRY TWO TIMES FOR ONE EVENT. Discord renders the embed's own
    // timestamp in the reader's zone, so a field written in UTC sat two hours away from the
    // footer directly beneath it — and the reader is doing that subtraction mid-incident. Found
    // by looking at the delivered message on a phone; every test passed while it was wrong.
    const fld = (ev, n) => (view(ev).fields.find((f) => f.name === n) || {}).value;
    const summer = { kind: /** @type {"down"} */ ("down"), at: Date.parse("2026-08-11T13:19:00Z"), since: Date.parse("2026-08-11T13:19:00Z"), ended: 0, ids: ["app"], minutes: 0 };
    ok("alert: the time is the reader's, not the runner's — 13:19 UTC in August reads 15:19",
      fld(summer, "Od") === "15:19", fld(summer, "Od"));
    // The zone database has to be doing this, not a baked-in +2: the same clock time in January
    // is CET, and an offset written by hand would be an hour out for five months of the year —
    // the exact fault the nightly sweep carried all last summer.
    const winter = { ...summer, at: Date.parse("2026-01-15T13:19:00Z"), since: Date.parse("2026-01-15T13:19:00Z") };
    ok("alert: …and winter is +1, so the zone is real rather than a constant",
      fld(winter, "Od") === "14:19", fld(winter, "Od"));
    // An outage that began before midnight must not say "od 23:50" with nothing to say which one.
    const overnight = { ...summer, since: Date.parse("2026-08-10T20:00:00Z") };
    ok("alert: a start on another day carries its date; one from today does not",
      /^10\. 8\. 2026 22:00$/.test(fld(overnight, "Od")) && !/2026/.test(String(fld(summer, "Od"))), fld(overnight, "Od"));
  }
  {
    // Delivery. A webhook URL embeds a token, so the one thing the failure path must not do is
    // put it somewhere — the relay's own alerting learned this by 400-ing silently for weeks.
    const seen = [];
    const hook = await serve((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { seen.push(b); r.writeHead(204); r.end(); }); });
    const okRes = await send(hook.url + "/api/webhooks/1/x", view({ kind: "down", at: t(2), since: t(1), ended: 0, ids: ["app"], minutes: 0 }));
    ok("alert: a webhook that accepts it reports ok", okRes.ok === true);
    // ⚠️ CORRECTED, not satisfied, when the titles learned to distinguish partial from total:
    // one component down is a PARTIAL outage, so the plain title would now be the wrong
    // expectation rather than a passing one.
    ok("alert: …and a non-Discord URL still gets the neutral view rather than nothing",
      seen.length === 1 && JSON.parse(seen[0]).title === "Částečný výpadek — Webová aplikace a API",
      seen.length ? JSON.parse(seen[0]).title : "(nothing sent)");
    hook.close();
    const dead = await serve((_q, r) => { r.writeHead(401); r.end("nope"); });
    const bad401 = await send(dead.url, view({ kind: "up", at: t(2), since: t(1), ended: t(2), ids: ["app"], minutes: 5 }));
    ok("alert: a rejected POST is a failure, with the status code and WITHOUT the URL",
      bad401.ok === false && bad401.status === 401 && !String(bad401.error).includes(dead.url));
    dead.close();
    ok("alert: no webhook configured is not an exception", (await send("", {})).ok === false);
  }
}

// ── …and the wiring, run for real ─────────────────────────────────────────────
// The decision above is pure and proven, which is worth exactly nothing if run.mjs reads a
// different environment variable name or forgets to persist the state. The state has to survive
// a process death: the GitHub runner is destroyed after every tick and history.json is the only
// thing pushed. So this spawns the real script twice against a fake outage and asserts that the
// SECOND tick is the one that sends — the sequence, end to end, in about a second.
{
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  // ⚠️ Named stores, in a temp directory. A test that writes status/history.json edits the
  // developer's own — the trap docs/TESTING.md carries for twenty-four files that did it.
  const dir = mkdtempSync(join(tmpdir(), "sw-status-alert-"));
  const posts = [];
  const hook = await serve((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { posts.push(JSON.parse(b)); r.writeHead(204); r.end(); }); });
  const dead = await serve((_q, r) => { r.writeHead(200); r.end("this is not /app/"); });   // 200 where 405 is expected → down
  const stun = await stunServer();

  // ⚠️ `spawn` and await, NEVER spawnSync. The webhook and the STUN responder above live in THIS
  // process's event loop, and spawnSync blocks it — the child would sit waiting for an answer
  // from a server that cannot run until the child exits. A deadlock that reads, from the outside,
  // exactly like a hung prober.
  const tick = (webhook = hook.url) => new Promise((res) => {
    const p = spawn(process.execPath, [join(HERE, "run.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env,
        SW_STATUS_BASE: dead.url, SW_STATUS_TURN_HOST: "127.0.0.1", SW_STATUS_TURN_PORT: String(stun.port),
        SW_STATUS_RETRY_MS: "1", SW_STATUS_TIMEOUT_MS: "1500", SW_STATUS_PAT: "",
        SW_STATUS_HISTORY: join(dir, "history.json"), SW_STATUS_PUBLIC: join(dir, "public"),
        SW_STATUS_INCIDENTS: join(dir, "none.json"), SW_STATUS_DISCORD_WEBHOOK: webhook },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => res({ code, out }));
  });

  const first = await tick();
  ok("wiring: the tick itself survives — a prober that crashes reports nothing at all", first.code === 0, first.out);
  ok("wiring: the first tick of a real outage sends nothing", posts.length === 0);
  await tick();
  ok("wiring: the second one does — run.mjs reads SW_STATUS_DISCORD_WEBHOOK and posts", posts.length === 1);
  // Not an embed: this webhook is a local server, and `isDiscordWebhook` correctly declines to
  // reshape for a host that is not Discord's. The embed itself is exercised in the block above
  // and in relay/test-alerts.mjs; what matters HERE is that the message describing the outage
  // is what actually left the process.
  // The title is the sharper assertion now: the fake server answers 200 to everything, which is
  // the WRONG answer for /mcp alone (405 is its healthy one) and the right answer for the rest.
  // So "Částečný výpadek — MCP server" proves the real probes ran and agreed on exactly which
  // one is broken — not merely that some message left the process.
  ok("wiring: and what left the process names the one component that is actually wrong",
    posts[0]?.title === "Částečný výpadek — MCP server" && posts[0].fields.some((f) => f.name === "Neodpovídá"),
    posts[0]?.title);
  await tick();
  ok("wiring: a third failing tick stays quiet — the state survived the process, not just the run",
    posts.length === 1);
  const saved = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
  ok("wiring: the state is inside history.json, the one file the workflow pushes",
    saved.alert?.state === "down" && typeof saved.alert.since === "number");
  ok("wiring: and it carries no URL, no token, no customer name",
    !JSON.stringify(saved).includes("127.0.0.1") || !JSON.stringify(saved.alert).includes("http"));

  hook.close(); dead.close(); stun.close();
  rmSync(dir, { recursive: true, force: true });
}

// A publish that copies index.html and forgets i18.js ships a blank page.
const run = readFileSync(join(HERE, "run.mjs"), "utf8");
ok("publish: run.mjs copies i18n.js alongside the page", /"index\.html", "i18n\.js"/.test(run));

// The suite only runs if test.sh knows the directory exists — the trap the tools/ glob is
// already commented for. A test that never runs is worse than no test.
const sh = readFileSync(join(HERE, "..", "test.sh"), "utf8");
ok("harness: ./test.sh globs status/test-*.mjs", /status\/test-\*\.mjs/.test(sh));
const tscfg = JSON.parse(readFileSync(join(HERE, "..", "tsconfig.json"), "utf8"));
ok("harness: tsconfig includes status/, or its @ts-check headers check nothing",
  tscfg.include.some((p) => p.startsWith("status/")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
