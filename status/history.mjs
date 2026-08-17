// @ts-check
// The history store behind the public status page (w-a06b23), and the shape the page reads.
//
// The relay keeps audit events, usage stats and per-set health; it keeps no SERVICE-level
// history at all, so the 90-day bar had no source whoever drew it. This is that source.
//
// Two files, and the split is the point:
//   • history.json  — durable, one row per day per component plus a short raw tail. It lives on
//                     an orphan branch, not on main (status.yml explains why 288 commits a day
//                     is not a thing to do to a repository).
//   • status.json   — derived at publish time and thrown away; the only thing the page fetches.
//
// ⚠️ NOTHING IDENTIFYING MAY ENTER EITHER. The site-agent row is already reduced to a count in
// probe.mjs, before it reaches here, because both of these files end up published.
import { COMPONENTS } from "./probe.mjs";

/** @typedef {"ok"|"warn"|"down"|"none"} State */
/** @typedef {{ ok:number, warn:number, down:number }} Counts */

export const WINDOW_DAYS = 90;
/** The page stops claiming anything once its data is older than this. See index.html. */
export const STALE_AFTER_MIN = 15;
/** The raw tail kept for debugging a fresh fault — 24 h at a 5-minute cadence. */
export const KEEP_RECENT = 288;
/** Components whose failure IS our outage. The site aggregate is reported but never drives the
 *  banner: one customer's box being switched off is not a Screenwhere incident, and a page that
 *  cried outage over it would be ignored by the third week. */
export const INFRA = ["app", "docs", "mcp", "whep", "turn"];

/** UTC, because a prober on somebody else's fleet has no business inheriting its timezone. */
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

export const emptyHistory = () => ({ version: 1, days: /** @type {Record<string,Record<string,Counts>>} */ ({}), recent: /** @type {any[]} */ ([]), latest: /** @type {any} */ (null) });

/**
 * Fold one reading into the store. Pure — it returns a new object, so the suite can run a
 * hundred readings through it without a file anywhere.
 */
export function appendReading(hist, reading, { windowDays = WINDOW_DAYS, keepRecent = KEEP_RECENT } = {}) {
  // ⚠️ `alert` is carried, not rebuilt. This function names every field it keeps, so anything
  // else in the store is dropped by omission — and history.json is the ONLY thing that survives
  // a run (the workflow pushes it; the runner is destroyed). The alert state lived here for
  // about an hour before this line existed, during which every tick read back "first failure,
  // waiting for confirmation" and the second one never arrived. Silent, and the kind of silent
  // that only shows up during an actual outage.
  const out = { version: 1, days: { ...hist.days }, recent: [...hist.recent], latest: reading,
    ...(hist.alert ? { alert: hist.alert } : {}) };
  const key = dayKey(reading.ts);
  const day = { ...(out.days[key] || {}) };
  for (const c of COMPONENTS) {
    const st = reading.states[c.id];
    // `none` is not a sample. "We could not ask" must not be folded into uptime in either
    // direction — counting it as up would flatter us, counting it as down would libel us.
    if (st !== "ok" && st !== "warn" && st !== "down") continue;
    const prev = day[c.id] || { ok: 0, warn: 0, down: 0 };
    day[c.id] = { ...prev, [st]: prev[st] + 1 };
  }
  out.days[key] = day;
  out.recent.push({ ts: reading.ts, states: reading.states });
  if (out.recent.length > keepRecent) out.recent = out.recent.slice(-keepRecent);

  // Prune by DATE, not by count: a gap in the run (the cron paused, the repo went quiet) must
  // not shift ninety-day-old data forward into the window.
  const cutoff = dayKey(reading.ts - (windowDays - 1) * 86_400_000);
  for (const k of Object.keys(out.days)) if (k < cutoff) delete out.days[k];
  return out;
}

/**
 * The colour of one day. A single confirmed failure paints it — at a 5-minute cadence one `down`
 * sample IS a five-minute window in which the service did not answer, and rounding that away is
 * how a status page becomes decorative. (probe.mjs has already thrown out the unconfirmed ones.)
 * @returns {State|"nodata"}
 */
export function dayState(counts) {
  if (!counts) return "nodata";
  if (counts.down > 0) return "down";
  if (counts.warn > 0) return "warn";
  if (counts.ok > 0) return "ok";
  return "nodata";
}

/** Available = answered at all. A degraded sample is slow, not absent. */
export function uptimePct(list) {
  let up = 0, all = 0;
  for (const c of list) { if (!c) continue; up += c.ok + c.warn; all += c.ok + c.warn + c.down; }
  return all === 0 ? null : (up / all) * 100;
}

/** Did anything in this window actually fail? Needed by the rounding rule below. */
export function anyDown(list) {
  for (const c of list) if (c && c.down > 0) return true;
  return false;
}

/**
 * 🚨 A ROUNDED 100 % NEXT TO A RED BAR IS A LIE, and at this cadence it is not hypothetical:
 * 90 days at one probe every five minutes is 25 920 samples, so a SINGLE five-minute outage
 * computes to 99.99614 % and `Math.round(p * 100) / 100` prints it as **100,00 %** — directly
 * beside the red day it just drew. The strip and the number would contradict each other, and
 * the eye believes the strip.
 *
 * So: two decimals as usual, except that a window containing any confirmed failure can never
 * display as a whole 100. It shows 99.99 — still the best two-decimal claim we are entitled to,
 * and no longer one the picture refutes.
 */
export function displayPct(pct, hadDown) {
  if (pct === null) return null;
  const r = Math.round(pct * 100) / 100;
  return hadDown && r >= 100 ? 99.99 : r;
}

/** The last `days` calendar days, oldest first, ending on the day of `now`. */
export function windowKeys(now, days = WINDOW_DAYS) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(now - i * 86_400_000));
  return out;
}

/**
 * The published document. Everything the page needs and nothing it does not — note that the
 * page is NOT told whether it is stale: it is given `generatedAt` and works that out itself,
 * because staleness is a fact about the moment somebody opens the page, not about the moment
 * it was written. A file cannot know it has gone out of date.
 */
export function buildStatus(hist, incidents, now = Date.now()) {
  const keys = windowKeys(now, WINDOW_DAYS);
  const latest = hist.latest;
  const components = COMPONENTS.map((c) => {
    const counts = keys.map((k) => hist.days[k]?.[c.id]);
    const days = keys.map((k) => dayState(hist.days[k]?.[c.id]));
    const pct = displayPct(uptimePct(counts), anyDown(counts));
    return {
      id: c.id, nm: c.nm, ep: c.ep,
      state: /** @type {State} */ (latest?.states?.[c.id] || "none"),
      detail: latest?.detail?.[c.id] || "",
      uptime90: pct,
      days,
    };
  });
  const infra = components.filter((c) => INFRA.includes(c.id));
  const overall = infra.every((c) => c.state === "down") && infra.length > 0 ? "down"
    : infra.some((c) => c.state === "down") ? "partial"
    : infra.some((c) => c.state === "warn") ? "warn"
    : infra.every((c) => c.state === "ok") ? "ok" : "none";
  const infraCounts = keys.flatMap((k) => INFRA.map((id) => hist.days[k]?.[id]));
  const overallPct = displayPct(uptimePct(infraCounts), anyDown(infraCounts));
  const cutoff = now - WINDOW_DAYS * 86_400_000;
  return {
    generatedAt: new Date(latest?.ts || now).toISOString(),
    staleAfterMin: STALE_AFTER_MIN,
    windowDays: WINDOW_DAYS,
    overall,
    overallPct,
    // Named so the banner can say what is NOT affected — "video is slow, control is not" is the
    // sentence that stops a degraded plane from reading as a dead product.
    affected: components.filter((c) => INFRA.includes(c.id) && (c.state === "down" || c.state === "warn")).map((c) => c.nm),
    unaffected: components.filter((c) => INFRA.includes(c.id) && c.state === "ok").map((c) => c.nm),
    components,
    incidents: (incidents || []).filter((n) => !n.at || Date.parse(n.at) >= cutoff),
  };
}
