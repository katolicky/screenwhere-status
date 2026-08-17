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
  { id: "site", kind: "agents",                              nm: { cs: "Zařízení na místě",     en: "Site agents" },    ep: { cs: "souhrn, bez identity", en: "aggregate, no identity" } },
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
 * /app/health lists named sets belonging to named customers, and that is precisely what a public
 * page must never carry, so the response is reduced here, at the edge, before anything is written
 * down. No name reaches the history file and none reaches the published JSON.
 *
 * It is also the only probe with a credential (a PAT in SW_STATUS_PAT). Without one the row says
 * "no data" rather than disappearing: a component that vanishes when it cannot be measured is how
 * a page ends up quietly narrower than the service it describes.
 * @returns {Promise<Reading & { total?:number, reachable?:number }>}
 */
export async function probeAgents(id = "site") {
  const pat = process.env.SW_STATUS_PAT;
  if (!pat) return { id, state: "none", ms: 0, detail: "no SW_STATUS_PAT configured" };
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/app/health`, {
      headers: { authorization: `Bearer ${pat}`, "user-agent": "screenwhere-status-probe" },
      cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    // ⚠️ "We could not ask" is NOT "they are down". When the relay is gone the infrastructure rows
    // already say so in red; claiming the agents are down too would be asserting something we did
    // not observe. This is the one place the built page differs from the approved mockup, where
    // the major-outage state painted this row red.
    if (!res.ok) return { id, state: "none", ms, detail: `could not ask: HTTP ${res.status}` };
    const body = await res.json();
    const sets = Array.isArray(body?.sets) ? body.sets : [];
    const total = sets.length;
    const reachable = sets.filter((s) => s && s.online).length;
    const state = /** @type {State} */ (total === 0 ? "none" : reachable === total ? "ok" : reachable === 0 ? "down" : "warn");
    return { id, state, ms, detail: `${reachable}/${total}`, total, reachable };
  } catch (e) {
    return { id, state: "none", ms: Date.now() - t0, detail: `could not ask: ${String((e && /** @type {Error} */ (e).message) || e)}` };
  }
}

/** One probe, with the single retry that keeps a dropped packet out of the record. */
async function once(comp) {
  if (comp.kind === "http") return probeHttp(BASE + comp.path, comp.expect, comp.id);
  if (comp.kind === "stun") return probeStun(TURN_HOST, TURN_PORT, comp.id);
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
