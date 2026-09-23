// @ts-check
// The prober behind the public status page (w-a06b23 · docs/STATUS-PAGE-PLAN.md).
//
// It runs OFF our infrastructure — GitHub Actions, route D — because the failure worth
// reporting is not "the relay process crashed" but "the box, its network or its TLS is gone",
// and Caddy, the relay, MediaMTX, coturn and the MCP server are five containers on ONE VPS.
// A prober next to them dies with them and buys nothing but the illusion of separation.
//
// Everything here answers from OUTSIDE, unauthenticated, and needed no relay change — the probe
// surface already existed when the decision was measured (2026-08-09):
//
//   GET /app/   → 200    Caddy + TLS + kac-relay serving
//   GET /docs/  → 200    the same relay's static plane
//   GET /mcp    → 405    kac-mcp is alive; a METHOD REFUSAL IS A LIVE ANSWER, so 405 is the
//                        expected code and a 200 here would be as wrong as a 502
//   GET /whep   → 200    kac-mediamtx, the video plane
//   udp/3478    → STUN   coturn. The one probe that is real work: TURN does not speak HTTP,
//                        so this is a hand-built binding request, not a fetch.
//
// ⚠️ ONE FAILED REQUEST IS NOT AN OUTAGE. A cron on somebody else's fleet has its own network,
// and a single dropped packet recorded as `down` would paint a red day for a fault that was
// never ours. Every probe that fails is therefore retried once after a pause, and only the
// second failure is recorded. This is the difference between a status page and a rumour.
import dgram from "node:dgram";
import { randomBytes } from "node:crypto";

/** @typedef {"ok"|"warn"|"down"|"none"} State */
/** @typedef {{ id:string, state:State, ms:number, detail:string }} Reading */

export const BASE = process.env.SW_STATUS_BASE || "https://app.screenwhere.com";
export const TURN_HOST = process.env.SW_STATUS_TURN_HOST || new URL(BASE).hostname;
export const TURN_PORT = Number(process.env.SW_STATUS_TURN_PORT || 3478);
/** How long any single attempt may take before it counts as a failure. */
export const TIMEOUT_MS = Number(process.env.SW_STATUS_TIMEOUT_MS || 10_000);
/** Answered, but slowly enough to be worth saying out loud. */
export const SLOW_MS = Number(process.env.SW_STATUS_SLOW_MS || 2_500);
/** The pause before the one retry. Overridable so the suite does not sleep for real —
 *  a duration that cannot be made short cannot be tested (the lesson v1.140.0 paid for). */
export const RETRY_MS = Number(process.env.SW_STATUS_RETRY_MS || 5_000);

/**
 * The components, in the order the page lists them. `agents` is last and is the only one that
 * needs a credential; see probeAgents for why it is a count and nothing else.
 */
export const COMPONENTS = [
  { id: "app",  kind: "http", path: "/app/",  expect: [200], nm: { cs: "Webová aplikace a API", en: "Web app & API" },  ep: "app.screenwhere.com/app/" },
  { id: "docs", kind: "http", path: "/docs/", expect: [200], nm: { cs: "Dokumentace",           en: "Documentation" },  ep: "/docs/" },
  { id: "mcp",  kind: "http", path: "/mcp",   expect: [405], nm: { cs: "MCP server",            en: "MCP server" },     ep: "/mcp" },
  { id: "whep", kind: "http", path: "/whep",  expect: [200], nm: { cs: "Video (WHEP)",          en: "Video (WHEP)" },   ep: "/whep" },
  { id: "turn", kind: "stun",                                nm: { cs: "TURN relay (coturn)",   en: "TURN relay (coturn)" }, ep: "udp/3478 · STUN" },
  // ⚠️ The label names the PROPERTY, not the box (owner, 2026-09-21). It read "Zařízení na
  // místě" / "Site agents", which a reader takes to cover everything in the room — televisions
  // included — while what is actually measured is one thing: does the unit at the site hold a
  // live link to the relay. A television can be switched off with this row green. And the public
  // page deliberately says nothing about what the unit IS: the owner will not advertise the
  // hardware, any more than the count (`w-99ae61`).
  { id: "site", kind: "agents",                              nm: { cs: "Připojení lokalit",     en: "Site connectivity" }, ep: { cs: "souhrn, bez identity", en: "aggregate, no identity" } },
  // `w-1567c7`. Plugs are the EMERGENCY path — a hard power-cycle of the wall socket is the last
  // lever the product has when a television or an agent wedges — and until 2026-09-18 nothing
  // measured them continuously at all. They sit last because they are the newest row.
  //
  // ⚠️ They are a count for the same reason `site` is, but NOT for the reason this comment used
  // to give. It said "a plug belongs to a named customer's premises"; there are no customer
  // premises (owner, 2026-09-21: *„nic není u zákazníka! Jsme SaaS!"*). The count is here
  // because the owner will not publish how many devices the installation has (`w-99ae61`) —
  // an identity-free aggregate, not somebody else's property. Since 2026-09-21 both aggregate
  // rows DO drive the banner; see `PREMISES` in history.mjs.
  { id: "plugs", kind: "plugs",                              nm: { cs: "Zásuvky",               en: "Smart plugs" },    ep: { cs: "souhrn, bez identity", en: "aggregate, no identity" } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An HTTP probe. `expect` is a list because "alive" is not always 200 — /mcp answers 405 to a
 * GET and that is the healthy answer, so the code is compared, never merely `res.ok`.
 * @param {string} url @param {number[]} expect @returns {Promise<Reading>}
 */
export async function probeHttp(url, expect, id = "http") {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET", redirect: "manual", cache: "no-store",
      headers: { "user-agent": "screenwhere-status-probe" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (!expect.includes(res.status)) return { id, state: "down", ms, detail: `HTTP ${res.status}, expected ${expect.join("/")}` };
    if (ms > SLOW_MS) return { id, state: "warn", ms, detail: `answered in ${ms} ms` };
    return { id, state: "ok", ms, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { id, state: "down", ms: Date.now() - t0, detail: String((e && /** @type {Error} */ (e).message) || e) };
  }
}

/**
 * A STUN binding request over UDP — the only probe that cannot be a fetch.
 *
 * RFC 5389: a 20-byte header of type 0x0001, zero length, the magic cookie 0x2112A442 and a
 * 96-bit transaction id. coturn answers 0x0101 with the same id. Binding needs no credential
 * (an ALLOCATE would), so this asks exactly the question a public page may ask: is TURN there.
 * @returns {Promise<Reading>}
 */
export function probeStun(host = TURN_HOST, port = TURN_PORT, id = "turn") {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tx = randomBytes(12);
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0);      // Binding Request
    req.writeUInt16BE(0x0000, 2);      // no attributes
    req.writeUInt32BE(0x2112a442, 4);  // magic cookie
    tx.copy(req, 8);

    const sock = dgram.createSocket("udp4");
    let settled = false;
    const done = (/** @type {State} */ state, /** @type {string} */ detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closing */ }
      resolve({ id, state, ms: Date.now() - t0, detail });
    };
    const timer = setTimeout(() => done("down", `no STUN answer in ${TIMEOUT_MS} ms`), TIMEOUT_MS);

    sock.on("error", (e) => done("down", e.message));
    sock.on("message", (msg) => {
      // Anything on this socket came back from the address we dialled, but the transaction id
      // still has to match — otherwise a stray datagram would read as coturn answering.
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || !msg.subarray(8, 20).equals(tx)) return;
      const ms = Date.now() - t0;
      done(ms > SLOW_MS ? "warn" : "ok", `STUN binding success in ${ms} ms`);
    });
    sock.send(req, port, host, (e) => { if (e) done("down", e.message); });
  });
}

/**
 * The site-agent aggregate — a COUNT, and deliberately nothing else.
 *
 * 🚨 IT NO LONGER READS `/app/health` (`w-d433f4`). That endpoint lists NAMED sets belonging to
 * named sites, and this probe reduced them to a count on the runner — names crossing the wire
 * and being discarded afterwards. Worse, it is filtered by the caller's rights, so an honest
 * whole-installation count demanded a SUPERADMIN token in THIS PUBLIC REPOSITORY's Actions
 * secrets: a set with no teams, or one marked private, is visible to nobody else. The relay now
 * answers the same question in `/app/availability?summary=1` as `live.box` — two integers, no
 * identity, unfiltered — so the credential here can be a rights-less one and the count is still
 * complete. "The names were never here" beats "we removed the names".
 *
 * ⚠️ `live.box` and the hourly `kinds.box` are DIFFERENT measurements and this row wants the
 * first. The hour's verdict is an aggregate: a box that went away two minutes ago still reads
 * healthy until enough failed samples accumulate, which is the right answer to "what shape has it
 * been in" and the wrong one to "is it up now" — which is what this row has always said.
 *
 * ✅ It no longer needs a credential at all (`w-99ae61`). It used to be the only probe with one,
 * and that PAT had to belong to a SUPERADMIN to see the whole installation — sitting in this
 * public repository's Actions secrets. `/status-summary` answers the same question to anybody
 * and the secret is gone.
 * @returns {Promise<Reading & { total?:number, reachable?:number }>}
 */
export async function probeAgents(id = "site") {
  return probePublic(id, "box");
}

/**
 * The smart-plug aggregate (`w-1567c7`) — a COUNT, like the site row above, and for the same
 * reason: the owner does not publish how many devices the installation has (`w-99ae61`). NOT
 * because the plug belongs to somebody else — it does not; this is a SaaS and every plug counted
 * here is ours (owner, 2026-09-21).
 *
 * 🚨 THIS PROBE DOES NOT JUDGE. The relay answers `/app/availability?summary=1` with four
 * integers per kind that are ALREADY the verdict — how many plugs were reachable in the last
 * measured hour, how many were shaky, how many were not, and how many nobody measured. The
 * thresholds live in the relay's `shared/availstate.mjs` and deliberately never cross into this
 * repository: a number copied into a second repo with its own suite and its own release is a
 * number that can quietly come to mean something else, and nothing here would go red when it
 * did. `shared/discord.mjs` IS copied across, but that is a protocol, which cannot drift in
 * meaning the way a threshold can.
 *
 * 🚨 A plug is on a LAN behind NAT and this runner is on GitHub Actions, so it can never be
 * probed from here. What is being reported is the site agent's own measurement, relayed — and
 * that is exactly why `none` matters: see below.
 *
 * ⚠️ `none` is NOT `down`, and folding them would publish outages that never happened. A plug
 * counted `none` was not measured in the last hour — the relay restarted, a deploy happened, an
 * agent has not reported yet — and "nobody asked" is not "it did not answer". Same rule
 * `probeAgents` already follows when the relay will not answer at all.
 * @returns {Promise<Reading & { total?:number, reachable?:number }>}
 */
export async function probePlugs(id = "plugs") {
  return probePublic(id, "plug");
}

/**
 * Both aggregate rows, from ONE public endpoint (`w-99ae61`).
 *
 * 🚨 NO CREDENTIAL. `/status-summary` needs none — which is what replaced a PAT carrying its
 * owner's LIVE role into 133 of the relay's routes, sitting in THIS PUBLIC REPOSITORY's Actions
 * secrets. There is now nothing here to store, rotate, leak or revoke.
 *
 * 🚨 AND NO DENOMINATOR. Owner, 2026-09-18: *„Nechci veřejně zobrazovat, kolik mám zařízení …
 * ale nikdy není určeno z kolika."* The version before this built `detail` as "2/2" and "1/2"
 * and wrote it into the public `status.json` — and the agent row had done so since it was
 * written. The relay reaches the verdict itself and sends a state plus a count of what is NOT
 * working, so the total does not arrive here to be leaked by accident.
 *
 * ⚠️ `detail` therefore carries the FAILING count and never a ratio. `history.mjs` keeps it
 * verbatim in a public file, so anything put here is published.
 * @param {string} id @param {"plug"|"box"} kind
 * @returns {Promise<Reading & { failing?:number }>}
 */
async function probePublic(id, kind) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/status-summary`, {
      headers: { "user-agent": "screenwhere-status-probe" },
      cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    // ⚠️ "We could not ask" is NOT "they are down" — the same rule this file has always kept, and
    // it also covers the two-release window in which this page is newer than the relay: an older
    // relay has no `/status-summary` at all and answers 404, which must read "could not ask".
    if (!res.ok) return { id, state: "none", ms, detail: `could not ask: HTTP ${res.status}` };
    const k = (await res.json())?.kinds?.[kind];
    if (!k || typeof k.state !== "string") return { id, state: "none", ms, detail: "could not ask: no summary" };
    const failing = Number(k.failing) || 0;
    // 🚨 `none` has no failing count because nothing was MEASURED, and a zero there is not good
    // news. This fell through to "all ok" — the in-app status card then printed "all ok" beside
    // its own "unknown" while the only site agent was silent (w-a17128, 2026-09-23). When the
    // silence began is added by `buildStatus`, which has the tail of readings; this has one.
    if (k.state === "none") return { id, state: "none", ms, detail: "nothing measured in the last hour" };
    // ⚠️ `detail` is published verbatim into the public `status.json` and shown in a day's
    // tooltip, so a bare number would be a meaningless "3" in a public file. It is written the
    // way this file's other probes write measurements ("HTTP 200", "STUN binding success in
    // 273 ms") — and crucially WITHOUT a denominator: never "3/7", which is the exact disclosure
    // the 2026-08-13 decision to leave this row dark was protecting.
    return { id, state: /** @type {State} */ (k.state), ms,
      detail: failing > 0 ? `${failing} failing` : "all ok", failing };
  } catch (e) {
    return { id, state: "none", ms: Date.now() - t0, detail: `could not ask: ${String((e && /** @type {Error} */ (e).message) || e)}` };
  }
}

/** One probe, with the single retry that keeps a dropped packet out of the record. */
async function once(comp) {
  if (comp.kind === "http") return probeHttp(BASE + comp.path, comp.expect, comp.id);
  if (comp.kind === "stun") return probeStun(TURN_HOST, TURN_PORT, comp.id);
  if (comp.kind === "plugs") return probePlugs(comp.id);
  return probeAgents(comp.id);
}
/** @returns {Promise<Reading>} */
export async function probeOnce(comp) {
  const first = await once(comp);
  if (first.state !== "down") return first;
  await sleep(RETRY_MS);
  const second = await once(comp);
  // Only the confirmed failure is recorded, and it says so — "one attempt failed, the retry
  // agreed" is a materially different claim from "a request timed out once".
  return second.state === "down" ? { ...second, detail: `${second.detail} (confirmed on retry)` } : second;
}

/**
 * Every component, concurrently. One reading = one row in the history file.
 * @returns {Promise<{ ts:number, states:Record<string,State>, detail:Record<string,string>, agents?:{total:number,reachable:number} }>}
 */
export async function runProbes(now = Date.now()) {
  const readings = await Promise.all(COMPONENTS.map((c) => probeOnce(c)));
  /** @type {Record<string,State>} */ const states = {};
  /** @type {Record<string,string>} */ const detail = {};
  let agents;
  for (const r of readings) {
    states[r.id] = r.state;
    detail[r.id] = r.detail;
    const a = /** @type {any} */ (r);
    if (r.id === "site" && typeof a.total === "number") agents = { total: a.total, reachable: a.reachable };
  }
  return { ts: now, states, detail, ...(agents ? { agents } : {}) };
}
