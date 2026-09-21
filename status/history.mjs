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
/**
 * One day of one component. The three counters are the whole uptime maths; `from`/`to`/`why`
 * are carried ONLY on a day that had trouble, and exist so a day bar can be hovered and say
 * WHAT happened (w-f40827) instead of only what colour it is.
 * @typedef {{ ok:number, warn:number, down:number, from?:string, to?:string, why?:string, whyState?:"warn"|"down" }} Counts
 */

export const WINDOW_DAYS = 90;
/** The page stops claiming anything once its data is older than this. See index.html. */
export const STALE_AFTER_MIN = 15;
/** The raw tail kept for debugging a fresh fault — 24 h at a 5-minute cadence. */
export const KEEP_RECENT = 288;
/** The probe cadence, in minutes — the Worker cron in worker/wrangler.toml. It is PUBLISHED
 *  rather than assumed by the page, because it is the only thing that turns "three failed
 *  samples" into "about fifteen minutes", and a page with the 5 baked in would go on saying
 *  fifteen after the cron changed. */
export const CADENCE_MIN = Number(process.env.SW_STATUS_CADENCE_MIN || 5);
/** A probe detail is our own sentence about our own endpoint, but an exception message can be
 *  arbitrarily long and this one ends up in a file every open tab re-fetches every minute. */
export const WHY_MAX = 140;
/**
 * The five planes we run in the cloud and probe directly from outside. They are named separately
 * from `INFRA` for ONE reason: `down` — "Rozsáhlý výpadek" — means the whole box stopped
 * answering, and that sentence can only ever be made about the planes this prober can reach. A
 * premises row cannot participate in it, because when the relay dies the plug and box rows go
 * `none` ("could not ask"), not `down`. Folding them in would have turned the one-box failure
 * into "výpadek části služby" — the total outage reported as a partial one.
 */
export const CORE = ["app", "docs", "mcp", "whep", "turn"];

/**
 * The devices we operate ON SITE, reported to us by the relay as a count and never a name.
 *
 * 🚨 THESE COUNT TOWARDS THE BANNER (owner, 2026-09-21), and that REVERSES what stood here.
 * The old rule kept them out, and its stated reason was *"one customer's box being switched off
 * is not a Screenwhere incident"* — `probe.mjs` said the same about a plug belonging to "a named
 * customer's premises". **That premise was never true of this product.** Owner, on being shown
 * the page: *„nic není u zákazníka! Jsme SaaS!"* Every box and every plug the prober counts is
 * our own installation, so there is no third party whose switched-off device we are politely
 * declining to report — there is only our own service, partly down.
 *
 * What the owner actually saw is the fault this fixes: the Zásuvky row read `down` while the
 * headline above it read "Všechny systémy fungují". A banner may not claim more than the thing
 * it measured, and the sentence it makes a reader believe is about the WHOLE page.
 */
export const PREMISES = ["site", "plugs"];

/** Everything the banner answers for, and everything the 90-day figure is made of. */
export const INFRA = [...CORE, ...PREMISES];

/** UTC, because a prober on somebody else's fleet has no business inheriting its timezone. */
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
/** …and the clock inside that day, same zone, for the tooltip's "14:05–14:20 UTC" line. */
export const hhmm = (ts) => new Date(ts).toISOString().slice(11, 16);

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
    const next = { ...prev, [st]: prev[st] + 1 };
    // A bad sample also leaves a trace of ITSELF, not just a tick in a column. Without this the
    // day bar can be red and still have nothing to say when somebody hovers it, which is the
    // moment they most want an answer (w-f40827).
    if (st !== "ok") {
      const at = hhmm(reading.ts);
      // `from`/`to` span every non-ok sample of the day, degraded ones included — it is the
      // window in which something was WRONG, and the tooltip labels it as exactly that rather
      // than as the outage. Both are UTC, like dayKey: a window whose two ends were read in
      // different zones is worse than no window.
      if (!next.from) next.from = at;
      next.to = at;
      // The `why` follows the DAY'S COLOUR, not the clock: a red day has to explain the failure
      // that made it red, even when the morning's merely-slow sample got here first. So the
      // first `down` displaces a `warn` reason, and after that nothing displaces it — later
      // faults on the same day belong in the incident timeline, not in a one-line tooltip.
      const why = String(reading.detail?.[c.id] || "").slice(0, WHY_MAX);
      if (why && (!next.why || (st === "down" && next.whyState !== "down"))) {
        next.why = why;
        next.whyState = st;
      }
    }
    day[c.id] = next;
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

/**
 * 🚨 `warn` MEANS TWO DIFFERENT THINGS, and until 2026-09-21 the maths knew only one of them.
 *
 * On the five cloud planes a `warn` sample is OUR OWN measurement of latency — it answered, just
 * slowly — so "available = answered at all" is right and it counts as up.
 *
 * On the two aggregate rows it is not a speed at all. The relay reports `warn` when SOME of the
 * devices are entirely dead and the rest are fine (`verdict()` in relay/avail.mjs). So with one
 * plug the row said `down` and the figure fell, and with two plugs and one dead it said `warn`
 * and the figure did not move AT ALL — a device stone dead, counted as available, under a label
 * reading "Zhoršené". Found 2026-09-21 auditing every sentence on the page; invisible today only
 * because exactly one plug is measured. Owner's call: partly dead is not available.
 *
 * Hence the flag. It is threaded from `PREMISES` at every call rather than guessed here, because
 * this function is also handed raw count lists by the suite.
 */
export const warnIsOutage = (id) => PREMISES.includes(id);

/** Available = answered at all — except where `warn` is not a speed. See `warnIsOutage`. */
export function uptimePct(list, warnDown = false) {
  let up = 0, all = 0;
  for (const c of list) {
    if (!c) continue;
    up += c.ok + (warnDown ? 0 : c.warn);
    all += c.ok + c.warn + c.down;
  }
  return all === 0 ? null : (up / all) * 100;
}

/** Did anything in this window actually fail? Needed by the rounding rule below. */
export function anyDown(list, warnDown = false) {
  for (const c of list) if (c && (c.down > 0 || (warnDown && c.warn > 0))) return true;
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
 * The outages the RECORD itself contains (`w-14c275`) — derived, never written by hand.
 *
 * 🚨 WHY THIS EXISTS. The Incidenty section read `incidents.json`, a hand-written file holding
 * `[]`, and printed "Za posledních 90 dní jsme nezaznamenali žádný incident." over a plug outage
 * that was happening as the owner read it (2026-09-21). The sentence did not measure what had
 * happened; it measured whether somebody had got round to writing it up — and nobody ever had.
 * index.html even stated the swap as an intention ("it says «nothing happened» rather than «no
 * records»"), which holds only while the file is maintained. It is the same fault as the banner
 * above it in `w-df5d2a`: a claim wider than the thing it measured.
 *
 * ⚠️ `none` MUST NOT PRODUCE AN INCIDENT, and that is the whole reason this walks `dayState`
 * rather than the raw counters. A day nobody measured is grey, not red — "we could not ask" is
 * not "it did not answer", the rule this file keeps everywhere else. Inventing an outage out of
 * silence is worse than the bug being fixed, because it cannot be checked against anything.
 *
 * ⚠️ And this stays LANGUAGE-NEUTRAL. It emits the component, the span and the counts; the page
 * makes the sentence, exactly as it already does for the day tooltips. A Czech verb agreeing
 * with a component name ("Zásuvky neodpovídaly" / "MCP server neodpovídal") is not something to
 * assemble in a data file.
 *
 * Runs are maximal and contiguous: three red days in a row are ONE outage, not three, because
 * that is what a person reading the section is counting.
 * @param {{id:string,nm:any,state:State,days:(State|"nodata")[],dayFacts:Record<string,any>}[]} components
 * @param {string[]} keys the window's day keys, oldest first — `days` is parallel to it
 */
export function deriveIncidents(components, keys) {
  const out = [];
  for (const c of components) {
    if (!INFRA.includes(c.id)) continue;
    let i = 0;
    while (i < c.days.length) {
      if (c.days[i] !== "down") { i++; continue; }
      let j = i;
      while (j + 1 < c.days.length && c.days[j + 1] === "down") j++;
      const span = keys.slice(i, j + 1);
      let down = 0, why = "";
      for (const k of span) {
        const f = c.dayFacts[k];
        if (!f) continue;
        down += f.down || 0;
        // The FIRST explanation of the outage, not the last: it is the one that says how it
        // began, and `appendReading` has already made a `down` reason outrank a `warn` one.
        if (!why && f.why) why = f.why;
      }
      out.push({
        id: c.id, nm: c.nm,
        from: span[0], to: span[span.length - 1],
        // ⚠️ Sample-derived and therefore APPROXIMATE — n windows of the probe cadence, not a
        // stopwatch. The page says "přibližně" for the same reason the day tooltip does.
        minutes: down * CADENCE_MIN,
        // Open only if this run reaches the newest column AND the component is still failing.
        // A red day that has ended is over even if it is today.
        ongoing: j === c.days.length - 1 && c.state === "down",
        ...(why ? { why } : {}),
      });
      i = j + 1;
    }
  }
  // Newest first, like the hand-written list the page merges these with.
  return out.sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
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
    const wd = warnIsOutage(c.id);
    const pct = displayPct(uptimePct(counts, wd), anyDown(counts, wd));
    // Keyed by date and carried ONLY for the days that had trouble. A green day needs nothing
    // beyond its date, and 90 × 6 objects of "nothing happened" would be most of a file that
    // every open tab re-fetches once a minute.
    /** @type {Record<string,{down:number,warn:number,from?:string,to?:string,why?:string}>} */
    const dayFacts = {};
    keys.forEach((k, i) => {
      const d = hist.days[k]?.[c.id];
      if (!d || (days[i] !== "down" && days[i] !== "warn")) return;
      dayFacts[k] = { down: d.down, warn: d.warn,
        ...(d.from ? { from: d.from } : {}), ...(d.to ? { to: d.to } : {}), ...(d.why ? { why: d.why } : {}) };
    });
    return {
      id: c.id, nm: c.nm, ep: c.ep,
      // The page needs to know which rows count devices, because on those a `warn` reads
      // "part of them is dead", not "it is slow" — a different word and a different colour of
      // claim. Published rather than re-derived, so the page keeps no copy of the list.
      ...(warnIsOutage(c.id) ? { aggregate: true } : {}),
      state: /** @type {State} */ (latest?.states?.[c.id] || "none"),
      detail: latest?.detail?.[c.id] || "",
      uptime90: pct,
      days,
      dayFacts,
    };
  });
  const core = components.filter((c) => CORE.includes(c.id));
  const infra = components.filter((c) => INFRA.includes(c.id));
  // ⚠️ The banner reads a premises `warn` as an outage for the same reason the figure does: it
  // is not a speed, it is some of the devices being dead. Without this a dead plug beside a live
  // one would read "Zhoršený provoz" — degraded — for something that is not answering at all.
  const stateOf = (/** @type {any} */ c) => (warnIsOutage(c.id) && c.state === "warn" ? "down" : c.state);
  // 🚨 `down` is asked of CORE and everything else of INFRA, and the asymmetry is the whole
  // design — see CORE above for why a premises row cannot say "everything is down".
  //
  // ⚠️ And `ok` is asked of CORE plus the ABSENCE of trouble anywhere, never of
  // `infra.every(ok)`. A plug row is `none` for up to an hour after every relay restart, and
  // `every(ok)` would have dropped the entire banner to "Nevíme, jaký je stav" each time — a
  // page that goes blank on a routine deploy is one nobody trusts on the day it means it.
  // `none` here is silence, and silence is neither a claim of health nor an accusation.
  const overall = core.every((c) => c.state === "down") && core.length > 0 ? "down"
    : infra.some((c) => stateOf(c) === "down") ? "partial"
    : infra.some((c) => stateOf(c) === "warn") ? "warn"
    : core.every((c) => c.state === "ok") ? "ok" : "none";
  // ⚠️ Summed PER COMPONENT rather than over one flat list, because the two aggregate rows count
  // a `warn` as unavailable and the five cloud planes do not. A single flat list cannot carry
  // two rules, and the flat version silently used the lenient one for all seven.
  let up = 0, all = 0, hadBad = false;
  for (const id of INFRA) {
    const wd = warnIsOutage(id);
    const list = keys.map((k) => hist.days[k]?.[id]);
    const p = uptimePct(list, wd);
    if (p !== null) for (const c of list) { if (!c) continue; up += c.ok + (wd ? 0 : c.warn); all += c.ok + c.warn + c.down; }
    if (anyDown(list, wd)) hadBad = true;
  }
  const overallPct = displayPct(all === 0 ? null : (up / all) * 100, hadBad);
  const cutoff = now - WINDOW_DAYS * 86_400_000;
  return {
    generatedAt: new Date(latest?.ts || now).toISOString(),
    staleAfterMin: STALE_AFTER_MIN,
    windowDays: WINDOW_DAYS,
    // 🚨 How many of those ninety days we actually MEASURED (w-2e88ec). The page used to say
    // "over the last 90 days we were available 99.98 %" from five days of samples, and the
    // number was honest — `nodata` is folded into uptime in neither direction — while the
    // sentence around it was not. The owner read the grey columns correctly and the headline
    // wrongly, which is the page's own subject: never let silence render as knowledge.
    daysWithData: keys.filter((k) => INFRA.some((id) => {
      const c = hist.days[k]?.[id];
      return !!c && (c.ok || 0) + (c.warn || 0) + (c.down || 0) > 0;
    })).length,
    // ⚠️ The dates the columns MEAN, published rather than recomputed in the browser. The page
    // used to derive them from the reader's own clock, which is a different clock and often a
    // different calendar day: a stale file, a phone hours behind, or simply a tab left open
    // across midnight all slid every label by a day while the bars stayed put (w-f40827).
    dayKeys: keys,
    cadenceMin: CADENCE_MIN,
    overall,
    overallPct,
    // Named so the banner can say what is NOT affected — "video is slow, control is not" is the
    // sentence that stops a degraded plane from reading as a dead product.
    affected: components.filter((c) => INFRA.includes(c.id) && (stateOf(c) === "down" || stateOf(c) === "warn")).map((c) => c.nm),
    unaffected: components.filter((c) => INFRA.includes(c.id) && c.state === "ok").map((c) => c.nm),
    components,
    incidents: (incidents || []).filter((n) => !n.at || Date.parse(n.at) >= cutoff),
    // The outages the record itself holds. `incidents` above stays what a person WROTE — the
    // analysis a probe cannot produce — and the page shows both. Neither stands in for the other.
    derived: deriveIncidents(components, keys),
  };
}

/**
 * 🚨 THE ONE INVARIANT THIS STORE HAS: inside the window, a reading never un-happens.
 *
 * Measured on 2026-09-14 (w-2e88ec): the live page drew 90 columns of which 85 said `nodata`,
 * because on 10 September a run rebuilt the store from scratch and force-pushed it over ninety
 * days of readings. 8 and 9 September had 296 successful runs each and not one of their samples
 * survived. Nothing in the pipeline objected, because nothing in the pipeline ever compared the
 * store it was about to publish with the one it was replacing.
 *
 * So this is that comparison, and it is deliberately about the PROPERTY rather than about the
 * shape of that day's accident: within the 90-day window, a day may not disappear and no counter
 * may go down. That is true of an empty store overwriting a full one, of a stale store from a
 * racing run, of a half-written file — and of whatever the next cause turns out to be.
 *
 * Days OUTSIDE the window are exempt: `appendReading` prunes them on purpose, and a guard that
 * called the daily prune "loss" would refuse every run on the ninety-first day.
 *
 * @param {any} before the store being replaced (the remote one, at push time)
 * @param {any} after  the store about to be written
 * @param {number} now the clock the window is measured from
 * @returns {string[]} one sentence per lost reading — empty means nothing is lost
 */
export function lossAgainst(before, after, now = Date.now()) {
  const cutoff = dayKey(now - (WINDOW_DAYS - 1) * 86_400_000);
  const mine = (after && after.days) || {};
  /** @type {string[]} */
  const out = [];
  for (const [day, comps] of Object.entries(((before && before.days) || {}))) {
    if (day < cutoff) continue;
    const day2 = mine[day];
    if (!day2) { out.push(`${day}: the whole day would vanish (${Object.keys(comps || {}).length} component rows)`); continue; }
    for (const [id, c] of Object.entries(comps || {})) {
      const m = day2[id];
      if (!m) { out.push(`${day}/${id}: the row would vanish (${(c.ok || 0) + (c.warn || 0) + (c.down || 0)} samples)`); continue; }
      for (const k of /** @type {const} */ (["ok", "warn", "down"])) {
        if ((m[k] || 0) < (c[k] || 0)) out.push(`${day}/${id}.${k}: ${c[k] || 0} → ${m[k] || 0}`);
      }
    }
  }
  return out;
}
