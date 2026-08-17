// @ts-check
// Telling somebody the infrastructure is gone (w-bc5fa5).
//
// The relay is the only sender of alerts this product has: an agent going offline, a scheduled
// run that did not pass. Which leaves exactly one event unreportable — the relay, the box or the
// domain going away — because the thing that would have to write the message is the thing that
// is down. This sender runs on GitHub Actions beside the prober, off our infrastructure, and
// therefore survives the failure it is describing.
//
// ⚠️ THE SITE-AGENT ROW NEVER FIRES ANYTHING. `INFRA` is imported from history.mjs rather than
// re-listed here, and that is deliberate: the page already refuses to let one customer's box
// being switched off paint the banner, and an alert that pinged a channel for it would be muted
// by the third week. One rule, one list.
import { COMPONENTS } from "./probe.mjs";
import { INFRA } from "./history.mjs";
import { discordBody, isDiscordWebhook } from "../shared/discord.mjs";
import { czPlural, durCs } from "./i18n.js";

/**
 * How many readings in a row make it real, in BOTH directions.
 *
 * ⚠️ This is a second confirmation, not a repeat of the one probe.mjs already does. That retry
 * fires five seconds later down the same wire from the same runner, so it catches a dropped
 * packet and nothing else; a GitHub runner whose egress hiccups for half a minute fails both
 * attempts and is recorded — correctly — as one red sample. Painting one bar red for that is
 * cheap. Waking somebody at three in the morning for it is not, so an alert waits for a second
 * tick, five minutes later, on what may well be a different runner entirely.
 *
 * Recovery is held to the same count on purpose. Announcing "resolved" from a single good
 * reading turns a flapping service into a stream of alternating messages, which is the same
 * channel-muting failure by another route.
 */
export const STREAK = Math.max(1, Number(process.env.SW_STATUS_ALERT_STREAK || 2));

/** What the store remembers between runs. `state` is what we have TOLD the world, not what the
 *  last probe saw — the gap between those two is the whole mechanism. */
export const emptyAlert = () => ({
  state: /** @type {"up"|"down"} */ ("up"),
  bad: false,          // what kind of reading the current streak is made of
  n: 0,                // how many like readings in a row
  firstTs: 0,          // when that streak began — the honest start of an outage, not the moment we admitted it
  since: /** @type {number|null} */ (null),  // start of the outage we announced
  ids: /** @type {string[]} */ ([]),         // everything seen down during it
});

const nameOf = (id) => COMPONENTS.find((c) => c.id === id)?.nm?.cs || id;

/**
 * The zone the times in a message are written in.
 *
 * 🚨 NOT UTC, and it was UTC for the first hour of this feature's life. Discord renders the
 * embed's own timestamp in the READER's zone — the card said "dnes v 15:19" in the footer while
 * the field above it said "13:19 UTC", so one message carried two different times for one event
 * and the reader had to subtract two hours during an incident. The prober's history keys stay
 * UTC (a bar of days must not shift when somebody travels); a message a person reads does not.
 * Found by looking at the delivered card on a phone — the code read fine.
 */
const TZ = process.env.SW_STATUS_TZ || "Europe/Prague";
const dayIn = (ts) => new Date(ts).toLocaleDateString("cs-CZ", { timeZone: TZ });
/** A bare time, plus the date ONLY when it is not the day the message is being sent — otherwise
 *  every card would carry a date that is always today, and an outage that started before midnight
 *  would say "od 23:50" with nothing to say which 23:50. */
const at = (ts, now) => {
  const t = new Date(ts).toLocaleTimeString("cs-CZ", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return dayIn(ts) === dayIn(now) ? t : `${dayIn(ts)} ${t}`;
};

/** Infrastructure components confirmed down in this reading. `warn` is slow, not absent. */
export const downIds = (reading) =>
  INFRA.filter((id) => reading?.states?.[id] === "down");

/**
 * Fold one reading into the alert state, and say whether that crosses a line.
 *
 * Pure, and separate from the sending, for the reason this whole page exists: the interesting
 * behaviour is a sequence over time, and a rule you can only exercise by actually being offline
 * for ten minutes is a rule nobody ever tests.
 *
 * @param {ReturnType<typeof emptyAlert>} prev
 * @param {{ts:number, states:Record<string,string>}} reading
 * @returns {{alert: ReturnType<typeof emptyAlert>, event: null | {kind:"down"|"up", at:number, since:number, ended:number, ids:string[], minutes:number}}}
 */
export function decide(prev, reading, streak = STREAK) {
  const a = { ...emptyAlert(), ...(prev || {}), ids: [...(prev?.ids || [])] };
  const ids = downIds(reading);
  const bad = ids.length > 0;

  if (bad !== a.bad || a.n === 0) { a.bad = bad; a.n = 1; a.firstTs = reading.ts; }
  else a.n += 1;

  // The union, not the latest: an outage that starts at /mcp and swallows the box a tick later
  // was about both, and the recovery message is the only place that ever gets to say so.
  if (bad && a.state === "down") for (const id of ids) if (!a.ids.includes(id)) a.ids.push(id);

  if (a.state === "up" && bad && a.n >= streak) {
    a.state = "down";
    a.since = a.firstTs;                 // when it actually began, not when we accepted it
    a.ids = ids.slice();
    return { alert: a, event: { kind: "down", at: reading.ts, since: a.since, ended: 0, ids: a.ids.slice(), minutes: 0 } };
  }
  if (a.state === "down" && !bad && a.n >= streak) {
    // The outage ended at the FIRST good reading, not at the one that convinced us.
    const ended = a.firstTs;
    const since = a.since ?? ended;
    const out = { kind: /** @type {"up"} */ ("up"), at: reading.ts, since, ended, ids: a.ids.slice(), minutes: Math.max(0, Math.round((ended - since) / 60_000)) };
    a.state = "up"; a.since = null; a.ids = [];
    return { alert: a, event: out };
  }
  return { alert: a, event: null };
}

/**
 * The message, as the neutral view `shared/discord.mjs` renders. Czech, because the person this
 * wakes reads Czech, and through `durCs`/`czPlural` because "1 minut" in the middle of the night
 * is how a channel stops being taken seriously (four of those have shipped here already).
 * @param {{kind:"down"|"up", at:number, since:number, ended?:number, ids:string[], minutes:number}} ev
 */
/**
 * What the title says beyond "something is wrong".
 *
 * 🚨 THE TITLE IS THE LOCK SCREEN. Discord's push notification shows it and nothing else, so for
 * as long as both kinds of outage were called "Výpadek infrastruktury" the phone could not tell
 * "the box is gone" from "one container of five is refusing" — you had to open the message to
 * learn whether to get up. Found by looking at four delivered cards as a LIST; each one on its
 * own read perfectly well.
 *
 * One part is named; more than one is counted, because the names are long ("Webová aplikace a
 * API") and three of them do not fit anywhere a title is read at a glance.
 */
const partOf = (ids) => (ids.length === 1 ? nameOf(ids[0]) : czPlural(ids.length, "část", "části", "částí"));
const isTotal = (ids) => ids.length >= INFRA.length;

export function view(ev) {
  const names = ev.ids.map(nameOf).join(", ");
  if (ev.kind === "down") {
    return {
      title: isTotal(ev.ids) ? "Výpadek infrastruktury" : `Částečný výpadek — ${partOf(ev.ids)}`,
      text: "Sonda mimo naši infrastrukturu nedostala odpověď. " + (ev.ids.length === INFRA.length
        ? "Neodpovídá **nic** — vypadá to na celý stroj, síť nebo doménu."
        : "Ostatní části zatím odpovídají."),
      tone: /** @type {"bad"} */ ("bad"),
      at: ev.at,
      fields: [
        { name: "Neodpovídá", value: names },
        { name: "Od", value: at(ev.since, ev.at) },
        { name: "Potvrzeno", value: `${czPlural(STREAK, "sonda", "sondy", "sond")} po sobě` },
      ],
    };
  }
  return {
    title: isTotal(ev.ids) ? "Obnoveno" : `Obnoveno — ${partOf(ev.ids)}`,
    // ⚠️ This sentence branches for the same reason the outage one does, and for a while it did
    // not: after a partial outage it announced that "all watched parts are answering AGAIN",
    // when four of the five had never stopped. True in letter, and claiming an event that did
    // not happen.
    text: isTotal(ev.ids)
      ? "Všechny sledované části zase odpovídají."
      : `Zase odpovídá i ${names}. Ostatní části nevypadly.`,
    tone: /** @type {"good"} */ ("good"),
    at: ev.at,
    fields: [
      { name: "Výpadek trval", value: ev.minutes < 1 ? "méně než minutu" : durCs(ev.minutes) },
      { name: "Týkalo se", value: names },
      // The real timestamp of the first good reading. Reconstructing it from the rounded
      // duration would print a minute that never happened, next to one that did.
      { name: "Konec", value: at(ev.ended || ev.at, ev.at) },
    ],
  };
}

/**
 * Which events may ping, given whatever mention is configured.
 *
 * **A recovery never pings.** It is the message whose entire content is "nobody needs to do
 * anything", and a channel that wakes people for good news is one they mute — after which the
 * outage message wakes nobody either. The relay decided this same thing for the same reason
 * (`relay/alerts.mjs`: "the test button and a recovery should not wake anyone").
 *
 * A rule, so it is here and tested, rather than an `if` at the call site in run.mjs where
 * nothing could see it.
 * @param {{kind:"down"|"up"}|null} ev
 */
export const mentionFor = (ev, configured) => (ev && ev.kind === "down" ? String(configured || "") : "");

/**
 * POST it. Errors are caught and reported, never thrown — a channel that cannot be reached must
 * not take down the run that still has history to write.
 *
 * The URL is a secret and embeds a token, so it is never logged, not even on failure. What IS
 * logged is the status code, which is the part that tells you whether the webhook was deleted.
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
export async function send(url, v, mention = "") {
  if (!url) return { ok: false, error: "no webhook configured" };
  // A non-Discord URL gets the same neutral view as plain JSON — the prober has no business
  // deciding somebody's generic consumer is unsupported.
  const body = isDiscordWebhook(url) ? discordBody({ ...v, ...(mention ? { mention } : {}) }) : JSON.stringify(v);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    return { ok: true, status: r.status };
  } catch (e) { return { ok: false, error: String((e && /** @type {Error} */ (e).message) || e) }; }
}
