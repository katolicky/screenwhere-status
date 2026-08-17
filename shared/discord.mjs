// @ts-check
// How a Discord webhook message is SHAPED — one implementation, two senders.
//
// ⚠️ THIS IS THE PUBLIC COPY (w-0ff9be, 2026-08-17). The relay's copy lives in the private
// `screenwhere` repo at shared/discord.mjs, and its header points back here. The move that
// split them was paid for consciously (public repo = free Actions minutes); the price is
// that a change to this rule now has TWO homes — change BOTH or the dialects drift apart,
// which is exactly the failure this file was created to end.
//
// The relay has spoken this dialect since the per-user notifications arc: a Discord webhook
// rejects any body without `content` or `embeds`, so a plain JSON POST 400s silently forever.
// The status prober (w-bc5fa5) is the second sender, and it does not run beside the relay at
// all — it runs on GitHub Actions, precisely so it survives the outage it reports. Two senders
// in two runtimes with two copies of one rule is how the keymap drifted (`w-c9821e`), so the
// rule lives here and both import it.
//
// Nothing in this file touches node, the filesystem or relay state — that is the standing
// contract of `shared/`, and it is what lets the prober import it without dragging the relay's
// config and state modules onto a GitHub runner.

const DISCORD_RE = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//i;

/** Discord's embed colours, as decimal ints (their API takes no hex strings). */
export const COLOR = { bad: 0xd9534f, good: 0x5cb85c, warn: 0xe6b450 };

export const isDiscordWebhook = (url) => DISCORD_RE.test(String(url || ""));

/** Discord truncates hard and 400s on oversize fields — keep every piece well inside. */
const clip = (s, n) => { const t = String(s == null ? "" : s); return t.length <= n ? t : t.slice(0, n - 1) + "…"; };

/**
 * A mention only NOTIFIES from `content` — Discord deliberately does not fire notifications for
 * text inside an embed, where it renders but pings nobody. So the ping rides above the card, and
 * `allowed_mentions` has to name the kind explicitly or Discord may swallow it.
 * Accepts `@everyone`, `@here`, `<@123>` / `<@!123>` (user), `<@&123>` (role), or a bare id.
 * Anything else is refused rather than pasted in — arbitrary text here would just be noise.
 *
 * 🚨 `parse` HAS EXACTLY THREE LEGAL VALUES — `roles`, `users`, `everyone` — and `everyone` is
 * the one that covers **both** @everyone and @here. Deriving the value from the text (`@here` →
 * `"here"`) reads perfectly and makes Discord answer **400 for the whole message**: not a ping
 * that fails, a message that never arrives. It was written that way from the start and the test
 * beside it asserted `"here"`, so the mistake was copied into the thing that was supposed to
 * catch it. Found 2026-08-11 by an actual 400 when the status prober was pointed at `@here`;
 * the relay escaped only because the owner had configured `@everyone`.
 * @returns {{content: string, allowed_mentions: object} | null}
 */
export function mentionPart(raw) {
  const m = String(raw || "").trim();
  if (!m) return null;
  if (m === "@everyone" || m === "@here") return { content: m, allowed_mentions: { parse: ["everyone"] } };
  let x = /^<@!?(\d{5,25})>$/.exec(m);
  if (x) return { content: `<@${x[1]}>`, allowed_mentions: { users: [x[1]] } };
  x = /^<@&(\d{5,25})>$/.exec(m);
  if (x) return { content: `<@&${x[1]}>`, allowed_mentions: { roles: [x[1]] } };
  x = /^(\d{5,25})$/.exec(m);                        // a bare id is the copy-paste people actually do
  if (x) return { content: `<@${x[1]}>`, allowed_mentions: { users: [x[1]] } };
  return null;
}

/**
 * Build a Discord embed from the neutral view.
 * @param {{title: string, text?: string, tone?: 'bad'|'good'|'warn', fields?: {name: string, value: string}[], at?: number, mention?: string}} view
 */
export function discordBody(view) {
  const fields = (view.fields || [])
    .filter((f) => f && f.name && f.value != null && String(f.value) !== "")
    .slice(0, 25)                                   // Discord's per-embed field cap
    .map((f) => ({ name: clip(f.name, 256), value: clip(f.value, 1024), inline: true }));
  const ping = mentionPart(view.mention);
  return JSON.stringify({
    ...(ping || {}),
    embeds: [{
      title: clip(view.title, 256),
      ...(view.text ? { description: clip(view.text, 4096) } : {}),
      color: COLOR[view.tone || "bad"],
      ...(fields.length ? { fields } : {}),
      timestamp: new Date(view.at || Date.now()).toISOString(),
      footer: { text: "Screenwhere" },
    }],
  });
}
