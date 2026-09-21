// @ts-check
// Strings and number agreement for the public status page (w-a06b23).
//
// This is a module rather than a block inside index.html for ONE reason: every count on that
// page sits next to a Czech noun that inflects, and this project has now shipped that wrong
// four times (v1.145.3 fixed eleven of them at once). A rule you can only read is a rule
// nobody checks — here the suite renders each of these at 1, 2 and 5 and compares the words.
//
// Loaded by the page as an ES module and imported directly by status/test-status.mjs, so the
// strings the test asserts on are the strings the browser gets. No copy, no drift.

/** "99,94 %" in Czech, "99.94 %" in English. */
export const pct = (p, lang) => (lang === "cs" ? p.toFixed(2).replace(".", ",") : p.toFixed(2)) + " %";

/**
 * Czech has three shapes after a number, not two — 1 / 2–4 / 5+ — and which of them a noun
 * takes also depends on the CASE the sentence puts it in. Both rules live here explicitly:
 * `one` is 1, `few` is 2–4, `many` is 5 and up.
 */
export const czPlural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

/**
 * "před …" takes the instrumental, where 2–4 and 5+ happen to agree ("před 2 minutami",
 * "před 5 minutami") and only 1 differs. Written as the full three-way call anyway, with the
 * two forms deliberately equal: the next person to touch this must not have to rediscover
 * which case the sentence was in.
 */
export function agoCs(sec) {
  if (sec < 60)    return "před " + czPlural(sec, "sekundou", "sekundami", "sekundami");
  if (sec < 3600)  return "před " + czPlural(Math.floor(sec / 60), "minutou", "minutami", "minutami");
  if (sec < 86400) return "před " + czPlural(Math.floor(sec / 3600), "hodinou", "hodinami", "hodinami");
  return "před " + czPlural(Math.floor(sec / 86400), "dnem", "dny", "dny");
}

export function agoEn(sec) {
  const u = (n, w) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (sec < 60)    return u(sec, "second");
  if (sec < 3600)  return u(Math.floor(sec / 60), "minute");
  if (sec < 86400) return u(Math.floor(sec / 3600), "hour");
  return u(Math.floor(sec / 86400), "day");
}

/**
 * A bare duration ("34 minuty", "47 minut") is the ACCUSATIVE/nominative shape, where all three
 * forms differ — this is the string the stale banner and every incident header show, and it is
 * the one that would have been wrong if it had been written around the number 2.
 */
export function durCs(min) {
  if (min < 60) return czPlural(min, "minutu", "minuty", "minut");
  return czPlural(Math.floor(min / 60), "hodinu", "hodiny", "hodin");
}

export function durEn(min) {
  const u = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return min < 60 ? u(min, "minute") : u(Math.floor(min / 60), "hour");
}

/**
 * 🚨 Say how many days the number is actually made of (w-2e88ec).
 *
 * The bar is ninety columns wide because the window is ninety days; how many of them were
 * MEASURED is a different number, and on 2026-09-14 it was five — the other 85 were grey
 * because the history had been wiped. "Za posledních 90 dní jsme byli dostupní 99,98 %" was
 * arithmetically honest (a day with no samples is folded into uptime in neither direction) and
 * the sentence was still a claim about three months we could not make. The owner read the grey
 * columns right and the headline wrong.
 *
 * So every string that would otherwise say "90 days" asks this first. A full window says the
 * plain sentence, so nobody has to rediscover it; a partial one names its own span.
 */
/**
 * How many of the bar's ninety columns the document has samples for — read from the document,
 * never assumed. It lives HERE, beside the strings it feeds, so the suite can test the real
 * decision rather than grep the page for the shape of a call: the first version of this guard
 * asserted `t.window(dw)` in index.html and a sabotaged `const dw = 90` walked straight past it
 * while staying green (the fault `CLAUDE.md` names — assert the property, not the shape).
 *
 * A document without the field is an older status.json: keep the original ninety-day wording
 * rather than invent a smaller claim out of a missing number.
 */
/**
 * Both incident sources, normalised and newest first (`w-14c275`).
 *
 * 🚨 IT LIVES HERE SO THE SUITE CAN RUN IT — the same reason `daysOnRecord` does, and for the
 * same reason spelled out beside that one. The first guard over this was a regex looking for
 * `derivedAsIncidents()` in index.html; it matched the function's own DEFINITION, so deleting
 * the call from the merge left the suite green over a page that had gone back to showing only
 * the hand-written list. A guard green over a live fault is worse than no guard. The page now
 * has no local copy of the decision for an edit to pin.
 *
 * `kind` is what the page renders differently: a hand-written entry carries a written analysis,
 * a derived one carries a component and a span and has its sentence made at render time.
 * @param {any} doc the published status document
 */
export function incidentEntries(doc) {
  const hand = ((doc && doc.incidents) || []).map((n) => ({ kind: "hand", at: n.at || "", n }));
  // A day key is a UTC calendar day; anchoring it at midnight UTC keeps the ordering in the same
  // zone the bar is drawn in, rather than in the reader's.
  const derived = ((doc && doc.derived) || []).map((d) => ({ kind: "derived", at: `${d.from}T00:00:00Z`, d }));
  return [...hand, ...derived].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
}

/**
 * The colour of TODAY's column — the worse of what the day recorded and what is true right now.
 *
 * 🚨 THE PAGE USED TO OVERWRITE THE RECORD WITH THE INSTANT, and the owner caught the result on
 * 2026-09-21: a plug that was down 05:15–08:55 UTC and had since recovered drew a GREEN column
 * whose own tooltip read "Nedostupné přibližně 3 hodiny". One tooltip contradicting itself.
 *
 * ⚠️ That overwrite was itself a fix, for the opposite case — "drawing it green under an «Outage»
 * badge", where the strip and the badge disagreed. Replacing the record with the instant cured
 * that direction and broke this one, because a day is not a moment. Taking the WORSE of the two
 * satisfies both: a day that had an outage stays red once it recovers, and a day whose record is
 * still empty (no samples since midnight UTC) cannot draw green under a failing row.
 *
 * ⚠️ The strip and the row's badge are then ALLOWED to disagree, and must: the strip answers
 * "what happened today", the badge answers "what is true now". The original reading of that
 * disagreement as a bug is what cost the record.
 * @param {string} recorded the day's own state, from the document
 * @param {string} current the component's state right now
 * @param {boolean} stale whether we have stopped believing the document at all
 */
export function todayState(recorded, current, stale) {
  if (stale) return "nodata";
  const rank = { ok: 0, warn: 1, down: 2 };
  const a = rank[recorded], b = rank[current];
  const worst = Math.max(a === undefined ? -1 : a, b === undefined ? -1 : b);
  return worst < 0 ? "nodata" : ["ok", "warn", "down"][worst];
}

/**
 * The CSS classes for one column. Today's gets `recovered` when the day is painted for trouble
 * that has since cleared — the bar then carries the day's colour with a green foot.
 *
 * ⚠️ WHY NOT SIMPLY AMBER (owner asked, 2026-09-21): amber already means "Zhoršené" — answering,
 * slowly. Painting "had an outage, fine now" with it would make a three-hour outage look exactly
 * like half an hour of latency, which is the one-name-two-facts fault this page was fixed for
 * twice the same day. And red is not "broken now": it is "this day had an outage", which is what
 * the other 89 columns mean too. So the hue keeps its meaning and the recovery is said beside it.
 * @param {string} drawn the state the column is painted for
 * @param {string} current the component's state right now
 * @param {boolean} isToday
 */
export function barClass(drawn, current, isToday) {
  const recovered = isToday && current === "ok" && (drawn === "down" || drawn === "warn");
  return recovered ? `${drawn} recovered` : drawn;
}

export const daysOnRecord = (doc) => (doc && Number.isInteger(doc.daysWithData) ? doc.daysWithData : 90);

export const dayCountCs = (n) => czPlural(n, "den", "dny", "dní");
export const dayCountEn = (n) => `${n} day${n === 1 ? "" : "s"}`;

export const STR = {
  cs: {
    what: "stav služby", app: "Aplikace ↗", other: "English",
    // The theme button carries no text, so these ARE its accessible name. They name the
    // destination of the click, not the state we are in.
    themeLight: "Přepnout na světlý režim", themeDark: "Přepnout na tmavý režim",
    components: "Součásti", incidents: "Incidenty",
    // `window` takes the number of days we have samples for, NOT the width of the bar.
    window: (n) => (n >= 90 ? "posledních 90 dní" : `${dayCountCs(n)} se záznamem z 90`),
    ok: "Dostupné", warn: "Zhoršené", down: "Výpadek", none: "Bez dat",
    // 🚨 The word for a `warn` on a row that COUNTS DEVICES. There it does not mean "slow" — it
    // means some of them are dead and the rest are fine, and calling that "Zhoršené" described a
    // stone-dead plug as a sluggish one (2026-09-21). The five cloud planes keep "Zhoršené",
    // where it really is a latency.
    partly: "Část nefunguje",
    legOk: "dostupné", legWarn: "zhoršené", legDown: "výpadek",
    legNone: "bez dat — nevíme, ne „v pořádku“",
    scale90: "před 90 dny", scaleToday: "dnes",
    // The day-bar tooltip (w-f40827). `tipDown`/`tipWarn` take a duration DERIVED from the
    // sample count, so they say "přibližně" — three failed probes are three five-minute windows
    // in which we got no answer, not a stopwatch reading.
    tipDown: (d) => `Nedostupné přibližně ${d}`,
    tipWarn: (d) => `Zhoršeně přibližně ${d}`,
    tipWindow: (a, b) => (a === b ? `Problém v ${a} UTC` : `Problémy ${a}–${b} UTC`),
    tipToday: "dnes, zatím",
    // 🚨 Today's column is red for what happened this MORNING while the row's badge says the
    // service is fine NOW, and those two are both true (owner, 2026-09-21). Without a sentence
    // saying so, the reader is left to work out why a red bar sits under a green badge — which
    // is the same puzzle, one step on, that made the old code overwrite the record in the first
    // place. So the tooltip says it out loud instead.
    tipRecovered: (at) => (at ? `Od ${at} UTC zase funguje.` : "Teď už zase funguje."),
    where: "sonda běží mimo naši infrastrukturu",
    // ⚠️ The cadence came from the document, not from this sentence, since 2026-09-21. It was
    // written "každých 5 minut" — the exact thing `CADENCE_MIN` is published to prevent, and the
    // comment beside it says so in as many words ("a page with the 5 baked in would go on saying
    // fifteen after the cron changed"). The day tooltip had been fixed; this string, one file
    // over, had not. Plural-aware because a changed cron would otherwise print "každých 2 minut".
    probe: (m = 5) => `Sonda běží každé ${czPlural(m, "minutu", "minuty", "minut")} mimo hlavní server.`,
    // 🚨 It said "Za posledních 90 dní jsme nezaznamenali žádný incident." over a plug outage in
    // progress (owner, 2026-09-21), because it described a hand-written file holding `[]` rather
    // than the record. Two faults in one sentence: it measured whether somebody had written an
    // incident up, and it claimed ninety days while twelve had been measured. Both gone — it is
    // now a statement about the RECORD, bounded by how much record there is, and the outages in
    // that record put themselves in the list (`deriveIncidents`).
    noIncidents: (n = 90) => `Za ${n >= 90 ? "posledních 90 dní" : `${dayCountCs(n)} se záznamem`} nemáme v záznamu žádný výpadek.`,
    resolved: "Vyřešeno", ongoing: "Probíhá",
    // The derived entries. A noun phrase on purpose: a Czech verb would have to agree with the
    // component name — "Zásuvky neodpovídaly" but "MCP server neodpovídal" — and that agreement
    // is not something a template can carry. See `w-1b2a78`.
    incTitle: (nm) => `Výpadek: ${nm}`,
    incFrom: "Začátek", incTo: "Konec", incDay: "Den",
    incApprox: (d) => `Nedostupné přibližně ${d}`,
    incSpanOne: (d) => d,
    incSpan: (a, b) => `${a} – ${b}`,
    incDerived: "ze záznamu sondy",
    tOk: "Všechny systémy fungují", tWarn: "Zhoršený provoz", tPartial: "Výpadek části služby",
    tDown: "Rozsáhlý výpadek", tStale: "Nevíme, jaký je stav",
    // ⚠️ "pět rovin" until 2026-09-21, when the banner started answering for seven. A count
    // written into a sentence is a fact about the code that no test was ever going to hold to
    // it — the list grew twice before anybody noticed this line had not. It says no number now,
    // so it cannot go stale again.
    xOk: (p, n = 90) => (p == null ? "Sledujeme všechny roviny služby."
      : n >= 90 ? `Za posledních 90 dní jsme byli dostupní ${pct(p, "cs")} času.`
      : `Za ${dayCountCs(n)} se záznamem jsme byli dostupní ${pct(p, "cs")} času.`),
    xWarn: (a, u) => `Zhoršeně odpovídá: ${a}.` + (u ? ` Ostatní roviny to neovlivňuje (${u}).` : ""),
    // ⚠️ "Nefunguje", not "Neodpovídá": since the aggregate rows reach this sentence, it has to be
    // true both of a plane that is silent and of a row where some devices are dead and some are
    // not. "Does not answer" is a claim about the whole row and would be false of the second.
    xPartial: (a, u) => `Nefunguje: ${a}.` + (u ? ` Zbytek služby běží (${u}).` : ""),
    xDown: "Server neodpovídá na žádné rovině.",
    xStale: (d) => `Tahle stránka se neaktualizovala ${d}. Poslední známý stav si tu můžeš přečíst níž, ale neručíme za něj — mlčí sonda, ne nutně služba.`,
    xNoData: "Nepodařilo se načíst data o stavu. Neznamená to, že je služba mimo provoz — znamená to, že tahle stránka teď nic neví.",
    checkedNever: "Zatím bez měření",
    checked: (sec) => `Poslední kontrola ${agoCs(sec)}`,
    dur: durCs,
  },
  en: {
    what: "service status", app: "The app ↗", other: "Česky",
    themeLight: "Switch to the light theme", themeDark: "Switch to the dark theme",
    components: "Components", incidents: "Incidents",
    window: (n) => (n >= 90 ? "last 90 days" : `${dayCountEn(n)} on record of 90`),
    ok: "Available", warn: "Degraded", down: "Outage", none: "No data",
    // See the Czech note — "Degraded" described a dead device as a slow one.
    partly: "Partly down",
    legOk: "available", legWarn: "degraded", legDown: "outage",
    legNone: "no data — “unknown”, not “fine”",
    scale90: "90 days ago", scaleToday: "today",
    tipDown: (d) => `Unavailable for about ${d}`,
    tipWarn: (d) => `Degraded for about ${d}`,
    tipWindow: (a, b) => (a === b ? `Trouble at ${a} UTC` : `Trouble ${a}–${b} UTC`),
    tipToday: "today, so far",
    // See the Czech note — a red bar under a green badge, explained rather than left as a puzzle.
    tipRecovered: (at) => (at ? `Working again since ${at} UTC.` : "Working again now."),
    where: "probed from outside our infrastructure",
    // See the Czech note above — a cadence the page asserted instead of reading.
    probe: (m = 5) => `Probed every ${m === 1 ? "minute" : `${m} minutes`} from off our main server.`,
    // See the Czech note above — it described a hand-written file, not the record.
    noIncidents: (n = 90) => `No outage in the record for the ${n >= 90 ? "last 90 days" : `${n} day${n === 1 ? "" : "s"} on record`}.`,
    resolved: "Resolved", ongoing: "Ongoing",
    incTitle: (nm) => `Outage: ${nm}`,
    incFrom: "Started", incTo: "Ended", incDay: "Day",
    incApprox: (d) => `Unavailable for about ${d}`,
    incSpanOne: (d) => d,
    incSpan: (a, b) => `${a} – ${b}`,
    incDerived: "from the probe's record",
    tOk: "All systems operational", tWarn: "Degraded performance", tPartial: "Partial outage",
    tDown: "Major outage", tStale: "We do not know the current state",
    // See the Czech note above — a hard-coded plane count that nothing could keep honest.
    xOk: (p, n = 90) => (p == null ? "We watch every plane of the service."
      : n >= 90 ? `We were available ${pct(p, "en")} of the time over the last 90 days.`
      : `We were available ${pct(p, "en")} of the time over the ${dayCountEn(n)} we have on record.`),
    xWarn: (a, u) => `Responding slowly: ${a}.` + (u ? ` Other planes are unaffected (${u}).` : ""),
    // See the Czech note — true of a silent plane and of a partly-dead aggregate alike.
    xPartial: (a, u) => `Down: ${a}.` + (u ? ` The rest of the service is up (${u}).` : ""),
    xDown: "The server is answering on no plane.",
    xStale: (d) => `This page has not updated for ${d}. The last known state is below, but we do not stand behind it — it is the prober that is quiet, not necessarily the service.`,
    xNoData: "Could not load the status data. That does not mean the service is down — it means this page currently knows nothing.",
    checkedNever: "No measurement yet",
    checked: (sec) => `Last checked ${agoEn(sec)}`,
    dur: durEn,
  },
};

/**
 * One day bar, in words (w-f40827).
 *
 * The owner's ask was "hovering a day shows its date, and if something happened that day, the
 * detail of the problem too". Both halves live here rather than in index.html for the reason the
 * rest of this module exists: these sentences put counts next to Czech nouns, and the suite has
 * to render them at 1, 2 and 5 instead of reading them.
 *
 * ⚠️ `key` is the date the COLUMN means, taken from status.json — never one the browser worked
 * out from its own clock. Formatting is pinned to UTC for the same reason the store is: the bar
 * is a UTC day, and a reader in Auckland must not be shown yesterday's label on today's bar.
 *
 * @param {{ key:string, state:string, facts?:{down:number,warn:number,from?:string,to?:string,why?:string}|null, cadenceMin?:number, today?:boolean, now?:string }} d
 * @returns {{ head:string, state:string, lines:string[], why:string }}
 */
export function dayTip(d, lang) {
  const t = STR[lang];
  const locale = lang === "cs" ? "cs-CZ" : "en-GB";
  const head = new Date(`${d.key}T12:00:00Z`).toLocaleDateString(locale, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }) + (d.today ? ` · ${t.tipToday}` : "");
  const state = t[d.state === "nodata" ? "none" : d.state] || t.none;
  const lines = [];
  let why = "";
  // "No data" is a claim in its own right, and the page says so out loud everywhere else; the
  // tooltip is not the place to let it read as a quiet grey nothing.
  if (d.state === "nodata") lines.push(t.legNone);
  const f = d.facts;
  if (f) {
    const cad = d.cadenceMin || 5;
    if (f.down > 0) lines.push(t.tipDown(t.dur(f.down * cad)));
    if (f.warn > 0) lines.push(t.tipWarn(t.dur(f.warn * cad)));
    if (f.from && f.to) lines.push(t.tipWindow(f.from, f.to));
    why = f.why || "";
  }
  // ⚠️ Only on TODAY's column, and only when the row is actually fine again. On an older day
  // "it is working now" would be a statement about a different day, and on a row still failing
  // it would be false. `now` is the component's current state, handed in by the page.
  if (d.today && d.now === "ok" && (d.state === "down" || d.state === "warn")) {
    lines.push(t.tipRecovered(d.facts && d.facts.to));
  }
  // The probe's own sentence about its own endpoint — "HTTP 502, expected 200" — is returned
  // apart from our lines, and deliberately untranslated: it is a measurement, and rewording it
  // would leave it unmatchable against the logs of the run that produced it.
  return { head, state, lines, why };
}
