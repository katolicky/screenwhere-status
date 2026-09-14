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
    where: "sonda běží mimo naši infrastrukturu",
    probe: "Sonda běží každých 5 minut mimo hlavní server.",
    noIncidents: "Za posledních 90 dní jsme nezaznamenali žádný incident.",
    resolved: "Vyřešeno", ongoing: "Probíhá",
    tOk: "Všechny systémy fungují", tWarn: "Zhoršený provoz", tPartial: "Výpadek části služby",
    tDown: "Rozsáhlý výpadek", tStale: "Nevíme, jaký je stav",
    xOk: (p, n = 90) => (p == null ? "Sledujeme pět rovin služby."
      : n >= 90 ? `Za posledních 90 dní jsme byli dostupní ${pct(p, "cs")} času.`
      : `Za ${dayCountCs(n)} se záznamem jsme byli dostupní ${pct(p, "cs")} času.`),
    xWarn: (a, u) => `Zhoršeně odpovídá: ${a}.` + (u ? ` Ostatní roviny to neovlivňuje (${u}).` : ""),
    xPartial: (a, u) => `Neodpovídá: ${a}.` + (u ? ` Zbytek služby běží (${u}).` : ""),
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
    legOk: "available", legWarn: "degraded", legDown: "outage",
    legNone: "no data — “unknown”, not “fine”",
    scale90: "90 days ago", scaleToday: "today",
    tipDown: (d) => `Unavailable for about ${d}`,
    tipWarn: (d) => `Degraded for about ${d}`,
    tipWindow: (a, b) => (a === b ? `Trouble at ${a} UTC` : `Trouble ${a}–${b} UTC`),
    tipToday: "today, so far",
    where: "probed from outside our infrastructure",
    probe: "Probed every 5 minutes from off our main server.",
    noIncidents: "No incidents recorded in the last 90 days.",
    resolved: "Resolved", ongoing: "Ongoing",
    tOk: "All systems operational", tWarn: "Degraded performance", tPartial: "Partial outage",
    tDown: "Major outage", tStale: "We do not know the current state",
    xOk: (p, n = 90) => (p == null ? "We watch five planes of the service."
      : n >= 90 ? `We were available ${pct(p, "en")} of the time over the last 90 days.`
      : `We were available ${pct(p, "en")} of the time over the ${dayCountEn(n)} we have on record.`),
    xWarn: (a, u) => `Responding slowly: ${a}.` + (u ? ` Other planes are unaffected (${u}).` : ""),
    xPartial: (a, u) => `Not answering: ${a}.` + (u ? ` The rest of the service is up (${u}).` : ""),
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
 * @param {{ key:string, state:string, facts?:{down:number,warn:number,from?:string,to?:string,why?:string}|null, cadenceMin?:number, today?:boolean }} d
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
  // The probe's own sentence about its own endpoint — "HTTP 502, expected 200" — is returned
  // apart from our lines, and deliberately untranslated: it is a measurement, and rewording it
  // would leave it unmatchable against the logs of the run that produced it.
  return { head, state, lines, why };
}
