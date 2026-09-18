# The public status page — how it runs (`w-a06b23`)

`status.screenwhere.com`. The decision behind it is `docs/STATUS-PAGE-PLAN.md`; this file is
how the thing operates.

**Route D.** The prober runs on GitHub Actions and the page is served off a host that is not
ours. Not because the relay is unreliable, but because Caddy, the relay, MediaMTX, coturn and
the MCP server are **five containers on one VPS** — the failure worth reporting takes all five
at once, and anything standing beside them goes with it.

**The hostname is `status.`, not `stats.`** — the page is about *availability*, and the relay
already has a `stats.json` meaning *usage*.

## The parts

| File | What it is |
|---|---|
| `probe.mjs` | The five probes + the site-agent aggregate. Pure functions; nothing writes. |
| `history.mjs` | The store and the shape the page reads. Pure; the suite runs it without a file. |
| `alert.mjs` | Who gets told, and when. Pure decision + the sender; § Alerting below. |
| `run.mjs` | One tick: probe → fold → alert → write `public/`. What the workflow calls. |
| `store.mjs` | The store FILE and the branch it lives on: classify, write atomically, read/push a remote branch. |
| `fetch-history.mjs` | First step of a tick — bring the branch's store onto the runner, or fail loudly. |
| `publish-history.mjs` | Last step — check the push cannot lose readings, snapshot once a day, force-push. |
| `index.html` | The page. Static, fetches `status.json`, decides its own staleness. |
| `i18n.js` | Strings + every count-next-to-a-noun rule, as a module so the suite can render them. |
| `incidents.json` | **Hand-written.** The one part no probe can produce. |
| `test-status.mjs` | The suite. Run by `./test.sh` (and `./test.sh status`). |
| `test-store.mjs` | The suite for the store and the two git steps — every way the history could vanish. |

## Running it by hand

```sh
node status/run.mjs --dry        # probe production and print; writes nothing
node status/run.mjs              # …and fold it into status/history.json, build status/public/
node status/run.mjs --no-probe   # rebuild the page from the history already on disk
node status/run.mjs --serve      # …and serve it on 127.0.0.1:8845 (SW_STATUS_PORT to move it,
                                 #  SW_STATUS_HOST to bind elsewhere — loopback by default)
```

Environment (all optional, all with sane defaults): `SW_STATUS_BASE`, `SW_STATUS_TURN_HOST`,
`SW_STATUS_TURN_PORT`, `SW_STATUS_TIMEOUT_MS`, `SW_STATUS_SLOW_MS`, `SW_STATUS_RETRY_MS`,
`SW_STATUS_HISTORY`, `SW_STATUS_INCIDENTS`, `SW_STATUS_PUBLIC`,
`SW_STATUS_REMOTE` / `SW_STATUS_PUSH_URL` / `SW_STATUS_BRANCH` / `SW_STATUS_SNAPSHOT_BRANCH` /
`SW_STATUS_ALLOW_RESET` (the store's branch plumbing — § Where the history lives),
`SW_STATUS_CADENCE_MIN` (5 — how the tooltip turns failed samples into minutes), and for the
alert: `SW_STATUS_DISCORD_WEBHOOK`, `SW_STATUS_DISCORD_MENTION`, `SW_STATUS_ALERT_STREAK`,
`SW_STATUS_TZ` (default `Europe/Prague` — the zone the times in a message are written in; the
history keys stay UTC).

## Where the history lives

On the orphan branch **`status-data`**, holding exactly one commit, force-pushed each run. At a
five-minute cadence a commit per run would be 288 a day; `main` never sees any of them.

🚨 **It is not "data, not history", and losing it is not cheap** — this section used to say the
bar "rebuilds itself a day at a time", and that sentence is what made the loss below acceptable
to everyone who read it. A ninety-day bar rebuilds itself in ninety days.

**What happened (`w-2e88ec`, measured 2026-09-14).** The live page drew 90 columns of which 85
said `nodata`; the branch held five days. 8 and 9 September had 296 successful runs each and not
one of their samples survived: on 10 September a tick rebuilt the store from scratch and
force-pushed it over everything. The pipeline never objected, because it never compared the
store it was about to publish with the one it was replacing — and the run was green, so the loss
was found four days later by a person looking at the page.

Three things now stand between a bad tick and the history, and the first two are about telling
apart the two cases the old shell could not:

| | |
|---|---|
| `fetch-history.mjs` | "the branch does not exist" (a fresh start, said out loud, correct exactly once) vs. **"we could not read it"** — exit 1, history untouched. A lost tick costs one grey column. |
| `run.mjs` | A store file that exists and is not a store **stops the tick**. It used to fall back to an empty history, silently, and the next step published that. |
| `publish-history.mjs` | Re-reads the branch **at push time** and refuses a force-push that would lose a reading — `lossAgainst()` in `history.mjs`: inside the window no day disappears and no counter goes down. The branch is compared as it IS, not as this run fetched it, because ~296 runs a day against 288 slots means overlap is routine. |

`SW_STATUS_ALLOW_RESET=1` is the deliberate way past the first two, for a human who has looked.

**`status-data-daily`** is the recovery point: the store as it stood before the first tick of
each UTC day. `status-data` has no parentage, so without it there is nothing to go back to —
which is exactly the state the September wipe was discovered in. A failed snapshot warns and
never fails the tick.

## Writing an incident

`incidents.json` is an array, newest first, and it is the only part of the page a human writes.
The 90-day bar comes out of the prober for free; *what happened and what we did about it* does
not, and a status page whose incident list is empty for three months reads as one nobody
maintains.

```json
[
  {
    "at": "2026-08-03T14:02:00Z",
    "minutes": 34,
    "resolved": true,
    "title": { "cs": "Video rovina neodpovídala", "en": "Video plane not answering" },
    "timeline": [
      { "at": "14:02", "label": { "cs": "Zjištěno", "en": "Detected" },
        "text": { "cs": "sonda ohlásila, že /whep neodpovídá.", "en": "the prober reported /whep not answering." } },
      { "at": "14:36", "label": { "cs": "Vyřešeno", "en": "Resolved" },
        "text": { "cs": "kontejner znovu vytvořen.", "en": "container recreated." } }
    ]
  }
]
```

Entries older than 90 days are dropped at build time, so the file can simply be appended to.

## Hovering a day (`w-f40827`)

A ninety-day strip whose bars can only be a colour makes somebody who sees red do the one thing
a status page exists to prevent: ask us. So each bar says, on hover or tap, **which day it is**
and — when that day had trouble — **what happened**:

> **15. srpna 2026**  · Výpadek
> Nedostupné přibližně 15 minut
> Problémy 14:05–14:15 UTC
> `HTTP 502, expected 200 (confirmed on retry)`

Four decisions are worth keeping:

- **The dates come from the file, never from the reader's clock.** `status.json` publishes
  `dayKeys`, one per column, and the tooltip formats them **in UTC** — the store keys days in
  UTC, so a reader east of us must not be shown yesterday's date on today's bar. The page used
  to derive them with `Date.now()`, which relabelled every bar in a tab left open across
  midnight and in any browser whose clock disagreed with ours.
- **The minutes are derived, and say so.** Three failed probes are three five-minute windows in
  which nothing answered, not a stopwatch — hence *přibližně* / *about*, and hence `cadenceMin`
  being published rather than baked into the page. A cron that changes cadence changes the
  sentence with it.
- **The reason follows the day's colour.** `appendReading` keeps the first `down` detail of the
  day, and lets it displace a `warn` one that arrived earlier: a red day has to explain the
  failure that made it red. Later faults the same day belong in an incident, not in a tooltip.
- **A grey day still speaks.** It says *unknown, not fine*, the same words as the legend — and
  a day the page has stopped believing (today, past `staleAfterMin`) is given no facts to
  narrate, even when the file has some.

The probe's own sentence is quoted **verbatim and untranslated** (`HTTP 502, expected 200`): it
is a measurement, and rewording it would leave it unmatchable against the logs of the run that
produced it.

It is a real element rather than a `title` attribute, and that is not decoration — a native
tooltip appears after about a second, holds one line, and never appears at all on a phone, which
is where a link to this page usually gets opened. The same sentence is also each bar's
`aria-label` (`role="img"`), because a tooltip is a pointer affordance and the strip must not
read as ninety anonymous rectangles to anybody who is not using one.

⚠️ **Only the fade is animated.** Transitioning the tooltip's `transform` as well makes it fly
in from the corner, and — the part that actually breaks — `getBoundingClientRect()` during that
transition reports where the box is *on the way*, so the placement maths reads a rectangle that
is not where the box will be. It is positioned while still `visibility:hidden`, which keeps its
layout, and fades in already in the right place.

## What the page refuses to do

- **It will not claim a state it cannot back up.** `generatedAt` is compared against the
  reader's clock *in the reader's browser*; past `staleAfterMin` (15) the banner says
  "we do not know", the badges fall back to *no data*, and today's bar goes grey.
  A file cannot know it has gone out of date — only the page can.
- **Grey means unknown, never fine.** It is labelled that way in the legend on purpose.
- **It never carries a customer's name.** `/app/health` lists named sets at named sites;
  `probeAgents` reduces that to two integers at the edge, before anything is written down,
  because both the history file and the published JSON are public.
- **One failed request is not an outage.** Every failing probe is retried once; only the
  confirmed failure is recorded.
- **A site agent being offline does not turn the banner red.** One customer's box being
  switched off is not a Screenwhere incident. Only `INFRA` drives the overall state.

## Light and dark

Same shape as `docs/site/docs.css`, because these are the two public pages and they should read
as one product: `:root` is **light**, `html[data-theme="dark"]` is the explicit dark, and a
`prefers-color-scheme` block covers the third state — the empty `data-theme=""` the page ships
with, meaning *follow the machine*. The button in the nav writes `light`/`dark` into
`localStorage` under `sw-status-theme`, and an inline script in `<head>` applies it **before the
stylesheet**, or every load flashes the other theme first.

⚠️ **Nothing below the palettes may name a colour.** The page shipped dark-only, and two of its
literals were white at 5 % alpha — the *no data* badge and the stale banner's icon. On black they
were correct; on white they were not ugly, they were **gone**, and both of them mark the one
state this page exists to be honest about. `test-status.mjs` now fails on any white/black alpha
outside the token blocks, on a hard-coded `data-theme`, and when the two dark palettes drift
apart from each other.

## Hosting — the part that is the owner's, in order

> ✅ **DONE 2026-08-13 — the page is live at `https://status.screenwhere.com`** (200, valid
> certificate). Steps 1–5 below are the record of how, kept because they are the recipe for the
> next hostname. Two details were added that day: the upload takes a folder or a ZIP but **not** a
> single loose file, and step 5 does what it says but **not instantly** — the screen in between
> asks for a manual record it does not need.
> ✅ **`SW_STATUS_PAT` is RETIRED since `w-99ae61`** (2026-09-18) — it is not merely unset, there
> is no longer anything for it to do. See the end of this section. Nothing here is pending.

**Why it cannot be automated from here:** every step needs an authenticated Cloudflare session or
the token that session produces, and a credential must not pass through an assistant or through
chat. So this is a checklist rather than a script. The prober and the history work with none of it
— each run records history, skips publishing, and the run's notice names **which** secret is
missing (both are required; see the pairing comment in the workflow).

The domain is on Cloudflare Registrar under the `kac.dev` account (`docs/INFRA.md` § Domains).

1. **Create the Pages project.** Cloudflare dashboard → *Workers & Pages* → *Create application* →
   *Pages* → **Drag and drop your files** (labelled "Upload assets" in older docs; NOT "Import an
   existing Git repository" — the repository is private and the workflow uploads the built
   directory itself). Name it exactly **`screenwhere-status`**; the workflow passes that as
   `--project-name` and a mismatch is the one failure wrangler cannot guess its way out of.
   ⚠️ **The upload takes a FOLDER or a ZIP, never a single loose file** — the drop zone says "a
   file or folder" but the banner above it is the one telling the truth. Any placeholder is fine;
   the first real run replaces it. (Pages is reachable directly at
   `/<account>/workers-and-pages/create/pages` when the dashboard buries it under Workers.)
2. **Copy the account ID.** Same page, right-hand column, or the hex string in the dashboard URL
   after `/accounts/`. This is not a secret in the credential sense, but the workflow reads it
   from one so that nothing account-shaped sits in a public file.
3. **Make the API token.** *My Profile* → *API Tokens* → *Create Token* → **Custom token**, with
   exactly one permission: **Account · Cloudflare Pages · Edit**. Nothing else — this token can
   reach a production VPS through nothing, and it should stay that way. Scope it to the one
   account.
4. **Put both into the repository**, where the values never reach a terminal history or a chat:

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN     # paste at the prompt, then Ctrl-D
   gh secret set CLOUDFLARE_ACCOUNT_ID
   gh secret list                         # both should be listed; values are never readable back
   ```

5. **Attach the hostname.** Pages project → *Custom domains* → *Set up a custom domain* →
   `status.screenwhere.com`.
   Because the zone is in the same Cloudflare account, **Cloudflare writes the DNS record itself**
   — a Proxied `CNAME status → screenwhere-status.pages.dev`. Do **not** hand-create one, and above
   all never point the name at `178.105.255.25`. The whole design is that this hostname survives
   the main VPS being down.

   ⚠️ **It is not instant, and the screen in between is misleading.** For a minute or so the domain
   sits at `Initializing`, then `Verifying`, and while it does, Cloudflare shows a *"Complete DNS
   setup"* panel telling you to add that CNAME by hand and press *Check DNS records*. **That panel
   is the fallback for zones hosted elsewhere, not an instruction for this one.** Wait; the record
   appears on its own and the status goes `Active` / *SSL enabled*.
   🚨 Verified the hard way on 2026-08-13: the assistant read that panel, concluded this page was
   wrong, told the owner to create the record by hand, and rewrote this step to say Cloudflare does
   not do it. **The owner corrected it — it had already appeared on its own, seconds later.** The
   original sentence was right and the "correction" was a measurement taken too early. If you are
   reading a mid-transition screen, the thing to do is wait and re-measure, not rewrite the docs.
6. **Prove it rather than assume it.**

   ```sh
   gh workflow run status.yml && sleep 40 && gh run list --workflow=status.yml --limit 1
   ```

   *Publish page* must read **success**, not *skipped*. Then open `https://status.screenwhere.com`.

**`SW_STATUS_PAT` — RETIRED (`w-99ae61`, 2026-09-18). Nothing reads it; do not set it.**

**The history, because the reasoning is still the reasoning.** It was deliberately NOT set on
2026-08-13, and the site-agent row read *no data* on purpose. This page is **public**, and while
the probe was careful with NAMES — `probeAgents()` reduced `/app/health` to two integers at the
edge — `reachable/total` is *itself* a business fact: it would tell any visitor how many devices
are in operation, and keep telling them, historically. The plan protected the names and never
asked about the count; asked directly, the owner said no. So the row stayed dark, which was the
right call and a real loss: the page said nothing about the devices at all.

**What changed:** the trade was dissolved rather than settled. The relay now answers
`/status-summary` — no credential, and a state plus a count of what is NOT working, never a
total. Owner, 2026-09-18: *„Jedním ať to hlásí, že je vše ok. Případně že nefungují třeba 3
zařízení. Ale nikdy není určeno z kolika."* So both aggregate rows light up, no secret exists to
store or leak, and the count the 2026-08-13 decision was protecting never crosses the wire at
all — `availPublicState()` reaches the verdict inside the relay, which is the only way a
denominator can stay behind. ⚠️ Hiding it at THIS end would not have been the same thing: the
version that shipped hours earlier wrote "2/2" straight into the public `status.json`.

🚨 **And the instruction that used to sit here was impossible.** It read *"it must be a PAT that
can do nothing but read"* — but **a PAT carries no scope**. `resolvePat()` answers `{email, role}`
with the role read live from the user record, and `authsessions.mjs` says so out loud: *"Session/PAT
actors have no scope → full (true)"*. Only OAuth grants are scoped. So no such PAT could be made,
and anybody following the line would have minted a fully-privileged token believing otherwise.

It became possible on **2026-08-13** with the read-only `manager` role (v1.149.0): a PAT minted
under an account holding that role really is read-only, because the role is resolved live and the
relay refuses every write in one gate. So if this is ever wanted, the recipe is a **service account
with role `manager`**, added to the teams whose sets should be counted (`/app/health` filters by
`canSeeSet`) — never a `super` account, whose PAT would carry everything.

⚠️ **Until step 5 the page will answer on the `*.pages.dev` address Cloudflare assigns.** That is
worth opening once — it is the same page, and it separates "publishing works" from "DNS works",
which otherwise fail identically from the outside.

## Alerting — being told, rather than having to look (`w-bc5fa5`)

The relay writes every alert this product sends, which leaves exactly one event unsendable: the
relay, the box or the domain going away. The prober is already off our infrastructure, so it
sends that one. Reasoning: `docs/STATUS-PAGE-PLAN.md` § 8.

**The rule.** Two consecutive ticks with at least one infrastructure component `down` → one
message. Two consecutive clean ticks → one recovery message with how long it lasted. Nothing else
sends anything: no message per tick while it is down, none for a `warn` (slow is not absent), and
**none ever for the site-agent row** — one customer's box being switched off is not our incident.

**Setup — one secret, and it is the owner's for the same reason the Cloudflare ones are:**

```sh
gh secret set SW_STATUS_DISCORD_WEBHOOK    # paste at the prompt, then Ctrl-D
```

🚨 **Never paste the URL into a chat, a commit or a command line** — it embeds a token and anyone
holding it can post into the channel. `gh secret set` with no value on the command line prompts
for it and leaves nothing in shell history. The same rule the relay's own `alertWebhook` has had
since it existed.

Reuse the channel the relay already posts to, or make a second webhook for it — the prober does
not care, and a separate channel is the better answer if the existing one is busy: this one only
ever speaks when something is actually down.

**`SW_STATUS_DISCORD_MENTION` — set to `@here` (owner, 2026-08-11).** A ping has to ride ABOVE the
card, because Discord deliberately does not notify anyone for text inside an embed. Accepts
`@here`, `@everyone`, `<@&roleid>` or a bare user id; anything it cannot parse is dropped rather
than pasted in as noise. Unset, the message arrives silently.

🚨 **A recovery never pings, and that is a rule in code (`mentionFor`), not a habit.** It is the
message whose whole content is "nobody needs to do anything" — and a channel that wakes people
for good news is one they mute, after which the outage message wakes nobody either. The relay
decided the same thing for the same reason.

**The title is the lock screen.** Discord's push shows the title and nothing else, so an outage
that takes everything reads `Výpadek infrastruktury`, while one part refusing reads
`Částečný výpadek — MCP server` (two or more: `Částečný výpadek — 3 části`). Before that
distinction existed both said the same thing and the phone could not tell whether to get up.

**Without the secret nothing breaks.** The transition is still decided and recorded, and the run
prints a `::notice::` saying nothing was sent. The gate is inside `run.mjs` and not in a step's
`if:` — see the 🚨 in the workflow for why a secret in an `if:` is an invalid file rather than a
false condition.

**Proving it works without waiting for an outage:** point a run at a host that cannot answer.

```sh
SW_STATUS_BASE=https://example.invalid SW_STATUS_HISTORY=/tmp/h.json \
SW_STATUS_PUBLIC=/tmp/pub SW_STATUS_DISCORD_WEBHOOK='…' node status/run.mjs   # …twice
```

The first run says nothing and the second posts — that is the rule working, not a delay.

## Two things about GitHub's cron

It is **best-effort** — a `*/5` schedule slips under load — and it is **disabled automatically
after 60 days without repository activity**. Neither is a reason to move the prober onto our own
box, and both are why silence renders grey instead of green.
