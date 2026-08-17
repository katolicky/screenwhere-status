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

export const STR = {
  cs: {
    what: "stav služby", app: "Aplikace ↗", other: "English",
    // The theme button carries no text, so these ARE its accessible name. They name the
    // destination of the click, not the state we are in.
    themeLight: "Přepnout na světlý režim", themeDark: "Přepnout na tmavý režim",
    components: "Součásti", incidents: "Incidenty", window: "posledních 90 dní",
    ok: "Dostupné", warn: "Zhoršené", down: "Výpadek", none: "Bez dat",
    legOk: "dostupné", legWarn: "zhoršené", legDown: "výpadek",
    legNone: "bez dat — nevíme, ne „v pořádku“",
    scale90: "před 90 dny", scaleToday: "dnes",
    where: "sonda běží mimo naši infrastrukturu",
    probe: "Sonda běží každých 5 minut mimo hlavní server.",
    noIncidents: "Za posledních 90 dní jsme nezaznamenali žádný incident.",
    resolved: "Vyřešeno", ongoing: "Probíhá",
    tOk: "Všechny systémy fungují", tWarn: "Zhoršený provoz", tPartial: "Výpadek části služby",
    tDown: "Rozsáhlý výpadek", tStale: "Nevíme, jaký je stav",
    xOk: (p) => (p == null ? "Sledujeme pět rovin služby." : `Za posledních 90 dní jsme byli dostupní ${pct(p, "cs")} času.`),
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
    components: "Components", incidents: "Incidents", window: "last 90 days",
    ok: "Available", warn: "Degraded", down: "Outage", none: "No data",
    legOk: "available", legWarn: "degraded", legDown: "outage",
    legNone: "no data — “unknown”, not “fine”",
    scale90: "90 days ago", scaleToday: "today",
    where: "probed from outside our infrastructure",
    probe: "Probed every 5 minutes from off our main server.",
    noIncidents: "No incidents recorded in the last 90 days.",
    resolved: "Resolved", ongoing: "Ongoing",
    tOk: "All systems operational", tWarn: "Degraded performance", tPartial: "Partial outage",
    tDown: "Major outage", tStale: "We do not know the current state",
    xOk: (p) => (p == null ? "We watch five planes of the service." : `We were available ${pct(p, "en")} of the time over the last 90 days.`),
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
